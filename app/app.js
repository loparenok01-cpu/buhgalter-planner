'use strict';

// Планировщик бухгалтера — рабочий экран и вход.
// Формат даты на экране — DD-MM-YYYY (NFR-08).

const $ = (id) => document.getElementById(id);

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WEEKDAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Статусы задачи и их подписи (FR-32). Цвет задаётся классом плашки.
const STATUSES = [
  { id: 'todo', label: 'Нужно сделать' },
  { id: 'doing', label: 'В процессе' },
  { id: 'done', label: 'Сделано' },
  { id: 'sent', label: 'Отправлено' },
];

function formatDateRu(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

function isoToday() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

// Арифметика дат ведётся в UTC, чтобы переход на летнее время не сдвигал день.
function parseIsoDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoOfDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function addDays(isoDate, days) {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return isoOfDate(date);
}

// Понедельник недели, в которую входит дата (FR-01).
function startOfWeek(isoDate) {
  const date = parseIsoDate(isoDate);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return isoOfDate(date);
}

function showToday() {
  $('today').textContent = `Сегодня: ${formatDateRu(isoToday())}`;
}

function showServerStatus() {
  const node = $('server-status');

  fetch('/api/health')
    .then((response) => {
      if (!response.ok) throw new Error(`ответ ${response.status}`);
      return response.json();
    })
    .then((data) => {
      node.textContent =
        `Сервер: работает · схема данных ${data.schemaVersion} · проверка ${formatDateRu(data.time.slice(0, 10))}`;
    })
    .catch((error) => {
      node.textContent = `Сервер: недоступен (${error.message})`;
    });
}

// Обмен с сервером. Ответ приходит в JSON.
async function api(pathname, options) {
  const response = await fetch(pathname, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  // Сервер сообщает, что база не читается: показываем восстановление (AC-51).
  if (data && data.dbError) {
    showRecovery(data.detail || data.error);
  }

  return { ok: response.ok, status: response.status, data };
}

function showLogin() {
  $('recovery-screen').hidden = true;
  $('login-screen').hidden = false;
  $('app-screen').hidden = true;
  $('login-password').value = '';
  $('login-note').hidden = true;
  $('login-name').focus();
}

// Экран восстановления базы: копия или начало с нуля (FR-51, AC-51).
function showRecovery(detail) {
  $('login-screen').hidden = true;
  $('app-screen').hidden = true;
  $('recovery-screen').hidden = false;

  const node = $('recovery-error');
  if (detail) {
    node.textContent = `Сообщение сервера: ${detail}`;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }

  $('recovery-status').textContent = '';
  $('recovery-login').focus();
}

function showRecoveryError(message) {
  const node = $('recovery-error');
  node.textContent = message;
  node.hidden = false;
}

function recoveryCredentials() {
  const login = $('recovery-login').value.trim();
  const password = $('recovery-password').value;

  if (login.length === 0) {
    showRecoveryError('Укажите логин для входа');
    return null;
  }
  if (password.length < 6) {
    showRecoveryError('Пароль слишком короткий: нужно не меньше 6 символов');
    return null;
  }

  return { login, password };
}

// После восстановления показываем форму входа с подсказкой.
function finishRecovery(message) {
  showLogin();
  $('login-name').value = $('recovery-login').value.trim() || 'admin';
  const note = $('login-note');
  note.textContent = message;
  note.hidden = false;
  $('login-password').focus();
}

async function startFromScratch() {
  const credentials = recoveryCredentials();
  if (!credentials) return;

  if (!window.confirm('Создать пустую базу? Клиенты, задачи и платежи не восстановятся.')) return;

  const button = $('recovery-start');
  button.disabled = true;
  $('recovery-status').textContent = 'Создаю базу…';

  try {
    const result = await api('/api/recovery/start', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });

    if (!result.ok) {
      const errors = (result.data && (result.data.errors || [result.data.error])) || [];
      showRecoveryError(errors.join('; ') || 'Не удалось создать базу');
      return;
    }

    finishRecovery('База создана заново. Войдите с указанным логином и паролем.');
  } catch (error) {
    showRecoveryError(`Сервер недоступен: ${error.message}`);
  } finally {
    button.disabled = false;
    $('recovery-status').textContent = '';
  }
}

async function restoreFromBackup() {
  const credentials = recoveryCredentials();
  if (!credentials) return;

  const input = $('recovery-file');
  const file = input.files && input.files[0];
  if (!file) {
    showRecoveryError('Выберите файл копии JSON');
    return;
  }

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (error) {
    showRecoveryError('Файл не является корректным JSON');
    return;
  }

  const button = $('recovery-restore');
  button.disabled = true;
  $('recovery-status').textContent = 'Восстанавливаю копию…';

  try {
    const result = await api('/api/recovery/restore', {
      method: 'POST',
      body: JSON.stringify({ ...credentials, file: data }),
    });

    if (!result.ok) {
      const errors = (result.data && (result.data.errors || [result.data.error])) || [];
      showRecoveryError(errors.join('; ') || 'Не удалось восстановить копию');
      return;
    }

    const counts = result.data.counts || {};
    finishRecovery(
      `Копия восстановлена: клиентов ${counts.clients || 0}, задач ${counts.tasks || 0}. `
      + 'Войдите с указанным логином и паролем.',
    );
  } catch (error) {
    showRecoveryError(`Сервер недоступен: ${error.message}`);
  } finally {
    button.disabled = false;
    $('recovery-status').textContent = '';
  }
}

function showApp(session) {
  $('recovery-screen').hidden = true;
  $('login-screen').hidden = true;
  $('app-screen').hidden = false;
  $('account-login').textContent = session && session.login ? session.login : '';

  showToday();
  showServerStatus();
}

function showLoginError(message) {
  $('login-note').hidden = true;
  const node = $('login-error');
  node.textContent = message;
  node.hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();

  const button = event.target.querySelector('button[type="submit"]');
  const login = $('login-name').value.trim();
  const password = $('login-password').value;

  $('login-error').hidden = true;
  button.disabled = true;

  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });

    if (result.ok) {
      showApp(result.data);
      await loadUiSettings();
      if (!weekFrom) weekFrom = startOfWeek(isoToday());
      await loadWeek();
      return;
    }

    showLoginError((result.data && result.data.error) || 'Не удалось войти');
    $('login-password').value = '';
    $('login-password').focus();
  } catch (error) {
    showLoginError(`Сервер недоступен: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// --- Календарь нерабочих дней ---

let calendarCache = null;

// Смещение первого дня месяца: 0 — понедельник, 6 — воскресенье.
function firstWeekdayOffset(year, month) {
  const day = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (day + 6) % 7;
}

function formatHours(value) {
  return String(value).replace('.', ',');
}

function renderMonth(stats) {
  const year = stats.year;
  const card = document.createElement('div');
  card.className = 'cal-month';

  const title = document.createElement('h3');
  title.className = 'cal-month__title';
  title.textContent = MONTHS[stats.month - 1];
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  for (const name of WEEKDAYS) {
    const head = document.createElement('div');
    head.className = 'cal-grid__head';
    head.textContent = name;
    grid.appendChild(head);
  }

  for (let i = 0; i < firstWeekdayOffset(year, stats.month); i += 1) {
    const empty = document.createElement('div');
    empty.className = 'cal-day cal-day--empty';
    grid.appendChild(empty);
  }

  for (const item of stats.days) {
    const cell = document.createElement('div');
    cell.className = `cal-day cal-day--${item.kind}`;
    cell.textContent = item.day;
    grid.appendChild(cell);
  }

  card.appendChild(grid);
  return card;
}

function renderNorms(stats) {
  const body = $('calendar-norms-body');
  body.textContent = '';

  for (const month of stats.months) {
    const row = document.createElement('tr');
    row.innerHTML =
      `<td>${MONTHS[month.month - 1]}</td>` +
      `<td>${month.total}</td>` +
      `<td>${month.working}</td>` +
      `<td>${month.off}</td>` +
      `<td>${month.short}</td>` +
      `<td>${formatHours(month.norm40)}</td>`;
    body.appendChild(row);
  }

  const totals = stats.totals;
  const totalRow = document.createElement('tr');
  totalRow.className = 'is-total';
  totalRow.innerHTML =
    '<td>Итого за год</td>' +
    `<td>${totals.total}</td>` +
    `<td>${totals.working}</td>` +
    `<td>${totals.off}</td>` +
    `<td>${totals.short}</td>` +
    `<td>${formatHours(totals.norm40)}</td>`;
  body.appendChild(totalRow);
}

function renderCalendar() {
  const select = $('calendar-year');
  const year = Number(select.value);
  const stats = (calendarCache.years || []).find((item) => item.year === year);

  if (!stats) return;

  const months = $('calendar-months');
  months.textContent = '';
  for (const month of stats.months) {
    months.appendChild(renderMonth({ ...month, year }));
  }

  renderNorms(stats);
  renderJournal(calendarCache.updates || []);
  renderCalendarSources();
}

// Журнал обновлений календаря (FR-79): когда, откуда и за какие годы.
function renderJournal(updates) {
  const body = $('calendar-journal-body');
  body.textContent = '';

  for (const item of updates) {
    const row = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = formatDateRu(String(item.appliedAt).slice(0, 10));
    const sources = document.createElement('td');
    sources.textContent = item.sourceB ? `${item.sourceA} + ${item.sourceB}` : item.sourceA;
    const years = document.createElement('td');
    years.textContent = Object.keys(item.years || {}).sort().join(', ');
    const note = document.createElement('td');
    note.textContent = item.note || '';

    row.append(when, sources, years, note);
    body.appendChild(row);
  }

  $('calendar-journal-empty').hidden = updates.length > 0;
}

// --- Источники календаря: адреса вводятся вручную (FR-71) ---
//
// Список хранится на сервере в data/calendar-sources.json и может быть
// заменён целиком — код правил при этом не меняется.

let calendarSourcesModel = [];

function renderCalendarSources() {
  const rows = $('calendar-sources-rows');
  rows.textContent = '';

  if (calendarSourcesModel.length === 0) {
    calendarSourcesModel = ((calendarCache && calendarCache.sources) || [])
      .map((source) => ({ ...source }));

    if (calendarSourcesModel.length === 0) {
      calendarSourcesModel = [
        { id: 'source-1', title: '', url: '' },
        { id: 'source-2', title: '', url: '' },
      ];
    }

    const deadlines = (calendarCache && calendarCache.deadlinesSource) || {};
    $('deadlines-source-title').value = deadlines.title || '';
    $('deadlines-source-url').value = deadlines.url || '';
  }

  calendarSourcesModel.forEach((source, index) => {
    const row = document.createElement('div');
    row.className = 'calendar-sources__row';

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'calendar-sources__title';
    title.placeholder = 'Название';
    title.value = source.title || '';
    title.addEventListener('input', () => {
      calendarSourcesModel[index].title = title.value;
    });

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'calendar-sources__url';
    url.placeholder = 'https://…/calendar/{year}';
    url.value = source.url || '';
    url.addEventListener('input', () => {
      calendarSourcesModel[index].url = url.value;
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'calendar-sources__remove';
    remove.textContent = 'Убрать';
    remove.disabled = calendarSourcesModel.length <= 2;
    remove.addEventListener('click', () => {
      calendarSourcesModel.splice(index, 1);
      renderCalendarSources();
    });

    row.append(title, url, remove);
    rows.appendChild(row);
  });
}

function addCalendarSource() {
  calendarSourcesModel.push({
    id: `source-${Date.now()}`,
    title: '',
    url: '',
  });
  renderCalendarSources();
}

async function saveCalendarSources() {
  const status = $('calendar-sources-status');
  status.textContent = 'Сохраняем…';
  status.className = 'calendar-sources__status';

  const list = calendarSourcesModel.map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
  }));

  const result = await api('/api/calendar/sources-config', {
    method: 'PUT',
    body: JSON.stringify({ sources: list }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  if (!result.ok) {
    const errors = (result.data && result.data.errors) || ['Не удалось сохранить источники'];
    status.textContent = errors.join('; ');
    status.className = 'calendar-sources__status is-error';
    return;
  }

  calendarSourcesModel = (result.data.sources || []).map((source) => ({ ...source }));
  if (calendarCache) {
    calendarCache.sources = calendarSourcesModel.map(({ id, title, url }) => ({ id, title, url }));
  }

  // Календарь отчётности сохраняется там же, рядом с источниками.
  const deadlinesResult = await api('/api/calendar/deadlines-source', {
    method: 'PUT',
    body: JSON.stringify({
      source: {
        title: $('deadlines-source-title').value,
        url: $('deadlines-source-url').value,
      },
    }),
  });

  if (!deadlinesResult.ok) {
    const errors = (deadlinesResult.data && deadlinesResult.data.errors)
      || ['Не удалось сохранить календарь отчётности'];
    status.textContent = errors.join('; ');
    status.className = 'calendar-sources__status is-error';
    return;
  }

  if (calendarCache) calendarCache.deadlinesSource = deadlinesResult.data.source;

  status.textContent = 'Источники сохранены';
  status.className = 'calendar-sources__status is-ok';
  renderCalendarSources();
}

// --- Обновление календаря нерабочих дней (FR-71…FR-79) ---
//
// Два способа: данные с сайтов («Обновить календарь») и файл, заполненный
// по шаблону («Загрузить календарь»). В обоих случаях сначала показывается,
// что изменится, и только после подтверждения календарь применяется.

const CALENDAR_KINDS = [
  ['holidays', 'нерабочие дни'],
  ['workingSaturdays', 'рабочие субботы'],
  ['shortDays', 'сокращённые дни'],
];

const CALENDAR_STATUSES = {
  new: 'новый год',
  removed: 'год убирается',
  changed: 'есть изменения',
  same: 'без изменений',
};

let calendarMode = null;
let calendarSourceData = [];
let calendarFileData = null;
let calendarReady = false;
let calendarBusy = false;

function openCalendarModal(mode) {
  calendarMode = mode;
  calendarSourceData = [];
  calendarFileData = null;
  calendarReady = false;
  calendarBusy = false;

  $('calendar-modal-title').textContent = mode === 'sources'
    ? 'Обновление календаря с сайтов'
    : 'Загрузка файла календаря';
  $('calendar-modal-hint').textContent = mode === 'sources'
    ? 'Программа запросит данные у двух источников и сверит их. Календарь изменится, только если даты совпали.'
    : 'Выберите файл, заполненный по шаблону. Перед применением будет показано, что именно изменится.';

  $('calendar-file-row').hidden = mode !== 'file';
  $('calendar-file').value = '';
  $('calendar-progress').textContent = '';
  $('calendar-errors').textContent = '';
  $('calendar-errors').hidden = true;
  $('calendar-report').textContent = '';
  $('calendar-report').hidden = true;
  $('calendar-apply').disabled = true;
  $('calendar-apply').textContent = 'Применить';
  $('calendar-modal').hidden = false;
}

function closeCalendarModal() {
  $('calendar-modal').hidden = true;
}

function calendarProgressRow(text) {
  const row = document.createElement('div');
  row.className = 'calendar-progress__row';
  row.textContent = text;
  $('calendar-progress').appendChild(row);
  return row;
}

function showCalendarErrors(errors) {
  const list = $('calendar-errors');
  list.textContent = '';

  for (const message of errors) {
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  }

  list.hidden = errors.length === 0;
}

function calendarHeading(text) {
  const node = document.createElement('h3');
  node.className = 'calendar-report__title';
  node.textContent = text;
  return node;
}

// Отчёт о сверке источников и о том, что изменится (FR-72, FR-75, FR-77).
function renderCalendarReport(data) {
  const report = $('calendar-report');
  report.textContent = '';

  const differences = data.differences || [];
  if (differences.length > 0) {
    report.appendChild(calendarHeading('Расхождения между источниками'));

    const list = document.createElement('ul');
    list.className = 'calendar-diff';
    for (const item of differences) {
      const line = document.createElement('li');
      const kindLabel = item.kind === 'year' ? 'год' : (CALENDAR_KINDS.find(([key]) => key === item.kind) || [])[1];

      if (item.kind === 'year') {
        line.textContent = item.left
          ? `${item.year}: год есть только в первом источнике`
          : `${item.year}: год есть только во втором источнике`;
      } else {
        const where = item.left ? 'только в первом источнике' : 'только во втором источнике';
        line.textContent = `${formatDateRu(item.date)} — ${kindLabel}, ${where}`;
      }
      list.appendChild(line);
    }
    report.appendChild(list);
  }

  const changes = data.changes;
  if (changes) {
    report.appendChild(calendarHeading('Что изменится в календаре'));

    const list = document.createElement('ul');
    list.className = 'calendar-changes';
    let lines = 0;

    for (const change of changes.years) {
      for (const [kind, label] of CALENDAR_KINDS) {
        const added = change.added[kind] || [];
        const removed = change.removed[kind] || [];
        if (added.length === 0 && removed.length === 0) continue;

        const parts = [];
        if (added.length > 0) parts.push(`добавятся: ${added.map(formatDateRu).join(', ')}`);
        if (removed.length > 0) parts.push(`уберутся: ${removed.map(formatDateRu).join(', ')}`);

        const line = document.createElement('li');
        line.textContent = `${change.year} · ${label} — ${parts.join('; ')}`;
        list.appendChild(line);
        lines += 1;
      }
    }

    if (lines === 0) {
      const line = document.createElement('li');
      line.textContent = 'Даты календаря не изменятся';
      list.appendChild(line);
    }
    report.appendChild(list);

    const moves = (changes.tasks && changes.tasks.moves) || [];
    const skipped = (changes.tasks && changes.tasks.skipped) || [];

    if (moves.length > 0) {
      report.appendChild(calendarHeading(`Задачи, которые сдвинутся: ${moves.length}`));

      const table = document.createElement('table');
      table.className = 'calendar-tasks';
      const head = document.createElement('tr');
      for (const name of ['Клиент', 'Задача', 'Было', 'Станет']) {
        const cell = document.createElement('th');
        cell.textContent = name;
        head.appendChild(cell);
      }
      table.appendChild(head);

      for (const move of moves.slice(0, 50)) {
        const row = document.createElement('tr');
        for (const value of [move.client, move.title, formatDateRu(move.from), formatDateRu(move.to)]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.appendChild(cell);
        }
        table.appendChild(row);
      }

      report.appendChild(table);

      if (moves.length > 50) {
        const more = document.createElement('p');
        more.className = 'calendar-report__note';
        more.textContent = `Показаны первые 50 из ${moves.length} задач.`;
        report.appendChild(more);
      }
    } else {
      const note = document.createElement('p');
      note.className = 'calendar-report__note';
      note.textContent = 'Даты задач по правилам не изменятся.';
      report.appendChild(note);
    }

    if (skipped.length > 0) {
      const note = document.createElement('p');
      note.className = 'calendar-report__note calendar-report__note--warning';
      note.textContent = `Не сдвинутся ${skipped.length} задач: ${skipped[0].reason}`;
      report.appendChild(note);
    }
  }

  report.hidden = false;
}

// Проверка данных и показ отчёта; подтверждение применяет календарь.
async function requestCalendarCheck(body, endpoint) {
  const result = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (result.status === 401) {
    showLogin();
    return null;
  }
  if (!result.ok && !result.data) {
    showCalendarErrors(['Не удалось проверить данные календаря']);
    return null;
  }

  const data = result.data || {};
  showCalendarErrors(data.errors || []);
  renderCalendarReport(data);

  calendarReady = Boolean(data.valid);
  $('calendar-apply').disabled = !calendarReady;
  return data;
}

function calendarFetchYears() {
  const now = new Date();
  return [now.getFullYear(), now.getFullYear() + 1];
}

// «Обновить календарь»: по очереди оба источника, затем сверка (FR-71, FR-72).
async function runSourcesUpdate() {
  const sources = (calendarCache && calendarCache.sources) || [];

  if (sources.length < 2) {
    showCalendarErrors([
      (calendarCache && calendarCache.sourceError)
        || 'Нужны данные двух источников: проверьте файл настроек источников',
    ]);
    return;
  }

  const years = calendarFetchYears();
  const rows = new Map();

  for (const source of sources) {
    rows.set(source.id, calendarProgressRow(`${source.title} — запрашиваем ${years.join(', ')}…`));
  }

  calendarSourceData = [];

  for (const source of sources) {
    // Запросы идут по очереди: результат по каждому источнику показывается
    // отдельно (AC-85).
    // eslint-disable-next-line no-await-in-loop
    const result = await api('/api/calendar/fetch', {
      method: 'POST',
      body: JSON.stringify({ sourceId: source.id, years }),
    });

    const row = rows.get(source.id);

    if (!result.ok || !result.data) {
      row.textContent = `${source.title} — ошибка: ${(result.data && result.data.error) || 'нет ответа'}`;
      continue;
    }

    const blocks = {};
    const problems = [];

    for (const item of result.data.results) {
      if (item.ok && item.block) blocks[String(item.year)] = item.block;
      else problems.push(`${item.year}: ${item.error || 'нет данных'}`);
    }

    const got = Object.keys(blocks).sort().join(', ');
    if (got === '') {
      row.textContent = `${source.title} — не удалось получить данные: ${problems.join('; ')}`;
    } else {
      row.textContent = `${source.title} — получены данные за ${got}`
        + (problems.length > 0 ? `; без данных: ${problems.join('; ')}` : '');
      calendarSourceData.push({ id: source.id, title: source.title, blocks });
    }
  }

  if (calendarSourceData.length < 2) {
    showCalendarErrors([
      'Сверить источники не удалось: данные получены меньше чем от двух источников. Календарь не изменён.',
    ]);
    return;
  }

  await requestCalendarCheck({ confirm: false, sources: calendarSourceData }, '/api/calendar/sources');
}

// «Загрузить календарь»: файл, заполненный по шаблону (FR-77, FR-78).
async function handleCalendarFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];

  calendarFileData = null;
  calendarReady = false;
  $('calendar-apply').disabled = true;

  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    showCalendarErrors(['Файл не является корректным JSON']);
    renderCalendarReport({});
    return;
  }

  calendarFileData = { name: file.name, file: parsed };
  calendarProgressRow(`Файл: ${file.name}`);
  await requestCalendarCheck({ confirm: false, file: parsed, name: file.name }, '/api/calendar/file');
}

// Применение после подтверждения (FR-75, FR-77, FR-79).
async function applyCalendarChange() {
  if (!calendarReady || calendarBusy) return;

  const confirmed = window.confirm(
    'Применить новый календарь?\n' +
    'Задачи по правилам с новыми сроками сдвинутся. Выполненные и ручные задачи остаются на месте.',
  );
  if (!confirmed) return;

  calendarBusy = true;
  $('calendar-apply').disabled = true;
  $('calendar-apply').textContent = 'Применяем…';

  const body = calendarMode === 'sources'
    ? { confirm: true, sources: calendarSourceData }
    : { confirm: true, file: calendarFileData.file, name: calendarFileData.name };

  try {
    const data = await requestCalendarCheck(
      body,
      calendarMode === 'sources' ? '/api/calendar/sources' : '/api/calendar/file',
    );
    if (!data) return;

    if (!data.applied) {
      showCalendarErrors(data.errors.length > 0 ? data.errors : ['Календарь не применён']);
      return;
    }

    const moved = (data.movedTasks || []).length;
    closeCalendarModal();

    calendarCache = null;
    if (!$('deadlines-view').hidden && deadlinesTab === 'calendar') {
      if (await ensureCalendar()) renderCalendar();
    }
    await loadWeek();

    showNotice(moved > 0
      ? `Календарь обновлён. Задач с новыми сроками: ${moved}`
      : 'Календарь обновлён. Даты задач не изменились');
  } catch (error) {
    showCalendarErrors([`Не удалось применить календарь: ${error.message}`]);
  } finally {
    calendarBusy = false;
    $('calendar-apply').textContent = 'Применить';
  }
}

// «Шаблон календаря»: скачивание файла с пояснениями (FR-76).
async function downloadCalendarTemplate() {
  try {
    const response = await fetch('/api/calendar/template', { credentials: 'same-origin' });

    if (response.status === 401) {
      showLogin();
      return;
    }
    if (!response.ok) {
      showNotice('Не удалось скачать шаблон календаря', true);
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'calendar-template.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showNotice('Шаблон календаря сохранён: calendar-template.json');
  } catch (error) {
    showNotice(`Не удалось скачать шаблон: ${error.message}`, true);
  }
}

// --- Сверка сроков отчётности (FR-74, AC-88) ---
//
// Расчётные даты правил сверяются с календарём отчётности источника.
// Правила не изменяются: расхождения показываются предупреждением.
// Пока сверяется только 2026 год.

const REPORTING_COLUMNS = ['Налог', 'Что сверяем', 'Период', 'По правилам', 'На сайте', 'Результат'];

function reportingProgressRow(text) {
  const node = document.createElement('div');
  node.className = 'calendar-progress__row';
  node.textContent = text;
  $('reporting-progress').appendChild(node);
  return node;
}

function reportingDates(dates) {
  return (dates || []).map(formatDateRu).join(', ');
}

function reportingTable(rows) {
  const table = document.createElement('table');
  table.className = 'calendar-tasks';

  const head = document.createElement('tr');
  for (const name of REPORTING_COLUMNS) {
    const cell = document.createElement('th');
    cell.textContent = name;
    head.appendChild(cell);
  }
  table.appendChild(head);

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.status === 'diff') tr.className = 'is-warning';

    const values = [
      row.tax,
      row.action,
      row.periodLabel,
      reportingDates(row.appDates),
      reportingDates(row.siteDates),
      row.status === 'diff' ? 'расхождение' : 'совпадает',
    ];

    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }

  return table;
}

function renderReportingResult(data) {
  $('reporting-progress').textContent = '';

  for (const month of data.months || []) {
    const label = `${MONTHS[month.month - 1]} ${month.year}`;
    reportingProgressRow(month.ok
      ? `${label} — получено сроков: ${month.count}`
      : `${label} — ошибка: ${month.error}`);
  }

  const report = $('reporting-report');
  report.textContent = '';

  const warnings = data.warnings || [];
  const rows = data.rows || [];
  const same = rows.filter((row) => row.status === 'same');

  report.appendChild(calendarHeading(warnings.length > 0
    ? `Расхождения с сайтом: ${warnings.length}`
    : 'Расхождений с сайтом нет'));
  if (warnings.length > 0) report.appendChild(reportingTable(warnings));

  if (same.length > 0) {
    report.appendChild(calendarHeading(`Совпали с сайтом: ${same.length}`));
    report.appendChild(reportingTable(same));
  }

  const appOnly = data.appOnly || [];
  if (appOnly.length > 0) {
    report.appendChild(calendarHeading(`Нет на сайте: ${appOnly.length}`));
    const list = document.createElement('ul');
    list.className = 'calendar-changes';
    for (const item of appOnly) {
      const line = document.createElement('li');
      line.textContent = `${item.tax} · ${item.action} · ${item.periodLabel} — по правилам ${reportingDates(item.appDates)}`;
      list.appendChild(line);
    }
    report.appendChild(list);
  }

  const siteOnly = data.siteOnly || [];
  if (siteOnly.length > 0) {
    report.appendChild(calendarHeading(`Только на сайте: ${siteOnly.length}`));
    const list = document.createElement('ul');
    list.className = 'calendar-changes';
    for (const item of siteOnly) {
      const line = document.createElement('li');
      line.textContent = `${item.tax} · ${item.action} · ${item.periodLabel} — ${reportingDates(item.siteDates)}`;
      list.appendChild(line);
    }
    report.appendChild(list);
  }

  report.hidden = false;
}

async function runReportingCheck() {
  $('reporting-modal').hidden = false;
  $('reporting-progress').textContent = '';
  $('reporting-report').textContent = '';
  $('reporting-report').hidden = true;

  reportingProgressRow('Запрашиваем календарь отчётности за 2026 год…');

  const result = await api('/api/calendar/deadlines-check', {
    method: 'POST',
    body: JSON.stringify({ years: [2026] }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  if (!result.ok || !result.data) {
    $('reporting-progress').textContent = '';
    reportingProgressRow((result.data && result.data.error) || 'Не удалось сверить сроки');
    return;
  }

  renderReportingResult(result.data);
}

// --- Раздел «Сроки»: справочник правил и календарь (FR-44…FR-49) ---

let deadlinesTab = 'rules';
let referenceCache = null;

function updateDeadlinesTabs() {
  const calendar = deadlinesTab === 'calendar';
  $('deadlines-tab-rules').classList.toggle('is-active', !calendar);
  $('deadlines-tab-calendar').classList.toggle('is-active', calendar);
  $('reference-panel').hidden = calendar;
  $('calendar-panel').hidden = !calendar;
}

async function ensureCalendar() {
  if (calendarCache) return true;

  const result = await api('/api/calendar');
  if (result.status === 401) {
    showLogin();
    return false;
  }
  if (!result.ok) {
    alert('Не удалось загрузить календарь');
    return false;
  }

  calendarCache = result.data;
  calendarSourcesModel = [];

  const select = $('calendar-year');
  select.textContent = '';
  for (const item of calendarCache.years) {
    const option = document.createElement('option');
    option.value = item.year;
    option.textContent = item.year;
    select.appendChild(option);
  }
  return true;
}

async function ensureReference() {
  if (referenceCache) return true;

  const result = await api('/api/reference');
  if (result.status === 401) {
    showLogin();
    return false;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить справочник');
    return false;
  }

  referenceCache = result.data;
  return true;
}

// Справочник только для чтения: ни одного поля ввода или кнопки правки
// у правил нет (FR-45).
function renderReference() {
  if (!referenceCache) return;

  const groups = $('reference-groups');
  groups.textContent = '';

  $('reference-hint').textContent =
    `Горизонт: ${formatDateRu(referenceCache.horizon.from)} — ${formatDateRu(referenceCache.horizon.to)}. ` +
    'Правила приведены по разделу 8 и доступны только для чтения. ' +
    'Итоговые даты рассчитаны генератором по производственному календарю, с переносом на ближайший рабочий день.';

  for (const group of referenceCache.groups) {
    const section = document.createElement('section');
    section.className = 'reference-group';

    const title = document.createElement('h3');
    title.className = 'reference-group__title';
    title.textContent = `${group.section} ${group.title}`;
    section.appendChild(title);

    for (const rule of group.rules) {
      const card = document.createElement('article');
      card.className = 'reference-rule';

      const name = document.createElement('h4');
      name.className = 'reference-rule__title';
      name.textContent = rule.title;
      card.appendChild(name);

      const condition = document.createElement('div');
      condition.className = 'reference-rule__row';
      condition.innerHTML = '<span class="reference-rule__label">Условие</span>';
      const conditionText = document.createElement('span');
      conditionText.className = 'reference-rule__value';
      conditionText.textContent = rule.condition;
      condition.appendChild(conditionText);
      card.appendChild(condition);

      const calculation = document.createElement('div');
      calculation.className = 'reference-rule__row';
      calculation.innerHTML = '<span class="reference-rule__label">Расчёт</span>';
      const calculationText = document.createElement('span');
      calculationText.className = 'reference-rule__value';
      calculationText.textContent = rule.calculation;
      calculation.appendChild(calculationText);
      card.appendChild(calculation);

      const dates = document.createElement('div');
      dates.className = 'reference-rule__row';
      dates.innerHTML = '<span class="reference-rule__label">Итоговые даты</span>';

      const datesBody = document.createElement('span');
      datesBody.className = 'reference-rule__value reference-rule__dates';

      if (rule.dates.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'reference-date reference-date--empty';
        empty.textContent = 'задач в горизонте нет';
        datesBody.appendChild(empty);
      } else {
        for (const date of rule.dates) {
          const chip = document.createElement('span');
          chip.className = 'reference-date';
          chip.textContent = formatDateRu(date);
          datesBody.appendChild(chip);
        }
      }

      if (rule.dateNote) {
        const note = document.createElement('span');
        note.className = 'reference-rule__note';
        note.textContent = rule.dateNote;
        datesBody.appendChild(note);
      }

      dates.appendChild(datesBody);
      card.appendChild(dates);
      section.appendChild(card);
    }

    groups.appendChild(section);
  }
}

async function setDeadlinesTab(tab) {
  deadlinesTab = tab === 'calendar' ? 'calendar' : 'rules';
  updateDeadlinesTabs();

  if (deadlinesTab === 'calendar') {
    if (await ensureCalendar()) renderCalendar();
  } else if (await ensureReference()) {
    renderReference();
  }
}

async function openDeadlines() {
  $('registry-view').hidden = true;
  $('clients-view').hidden = true;
  $('week-grid').hidden = true;
  $('deadlines-view').hidden = false;

  deadlinesTab = 'rules';
  updateDeadlinesTabs();

  if (await ensureReference()) renderReference();
}

function closeDeadlines() {
  $('deadlines-view').hidden = true;
  $('week-grid').hidden = false;
}

// «Домой»: возврат на главный экран — сетку недели — из любого раздела.
function goHome() {
  hideTaskMenus();
  closeDatePicker();
  $('registry-view').hidden = true;
  $('deadlines-view').hidden = true;
  $('clients-view').hidden = true;
  $('week-grid').hidden = false;
}

// --- Клиенты ---

let clientsList = [];
let builtinFlags = [];
let editingClientId = null;
let formFlags = [];
let formFlagsChecked = new Set();

// Состояние сетки недели (FR-01…FR-05).
let weekFrom = null;
let weekData = null;
let weekRequestId = 0;

function metaLine(client) {
  const parts = [client.sno];
  if (client.vat) parts.push(`НДС ${client.vatRate} %`);
  else parts.push('без НДС');
  if (client.hasEmployees) parts.push('есть сотрудники');
  return parts.join(' · ');
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value === 'archive'
    ? 'archive'
    : 'active';
}

// --- Настройки вида (FR-52) ---
//
// Режим «Активные / Архивные» и текущая неделя хранятся на сервере,
// поэтому переживают перезагрузку страницы и смену браузера.

let settingsSaveTimer = null;

function applyUiSettings(ui) {
  const value = ui || {};

  if (value.mode === 'active' || value.mode === 'archive') {
    const radio = document.querySelector(`input[name="mode"][value="${value.mode}"]`);
    if (radio) radio.checked = true;
  }

  if (typeof value.weekStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.weekStart)) {
    weekFrom = value.weekStart;
  }
}

async function loadUiSettings() {
  const result = await api('/api/settings').catch(() => ({ ok: false }));

  if (result.status === 401) {
    showLogin();
    return false;
  }
  if (result.ok && result.data && result.data.ui) {
    applyUiSettings(result.data.ui);
  }
  return true;
}

function scheduleSettingsSave() {
  if (!weekFrom) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(saveUiSettings, 300);
}

async function saveUiSettings() {
  if (!weekFrom) return;

  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ ui: { weekStart: weekFrom, mode: currentMode() } }),
  }).catch(() => {});
}

function weekDays() {
  return Array.from({ length: 7 }, (_, index) => addDays(weekFrom, index));
}

function renderWeekHead() {
  const head = $('week-grid-head');
  head.textContent = '';

  const clientHead = document.createElement('th');
  clientHead.className = 'week-grid__client';
  clientHead.textContent = 'Клиент';
  head.appendChild(clientHead);

  for (const [index, day] of weekDays().entries()) {
    const headCell = document.createElement('th');
    headCell.className = 'week-grid__day';
    if (index >= 5) headCell.classList.add('is-weekend');
    if (day === isoToday()) headCell.classList.add('is-today');

    const weekday = document.createElement('div');
    weekday.className = 'week-grid__weekday';
    weekday.textContent = WEEKDAY_NAMES[index];

    const date = document.createElement('div');
    date.className = 'week-grid__date';
    date.textContent = formatDateRu(day);

    const count = document.createElement('span');
    count.className = 'week-grid__count';
    count.textContent = String((weekData && weekData.dayCounts[day]) || 0);
    count.title = `Задач за ${formatDateRu(day)}`;

    headCell.append(weekday, date, count);
    head.appendChild(headCell);
  }

  $('week-range').textContent = `Неделя: ${formatDateRu(weekFrom)} — ${formatDateRu(addDays(weekFrom, 6))}`;
}

function renderClientCell(client) {
  const cell = document.createElement('td');
  cell.className = 'week-grid__client';

  const name = document.createElement('div');
  name.className = 'client-name';
  name.textContent = client.name;
  cell.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'client-meta';
  meta.textContent = metaLine(client);
  cell.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'client-actions';

  const report = document.createElement('button');
  report.type = 'button';
  report.dataset.action = 'report';
  report.textContent = 'Отчётность';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.dataset.action = 'edit';
  edit.textContent = 'Изменить';

  const archive = document.createElement('button');
  archive.type = 'button';
  archive.dataset.action = 'archive';
  archive.textContent = client.archived ? 'Вернуть' : 'В архив';

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.dataset.action = 'pin';
  pin.textContent = client.pinned ? 'Закреплён' : 'Закрепить';
  if (client.pinned) pin.classList.add('is-active');

  actions.append(report, edit, archive, pin);
  cell.appendChild(actions);
  return cell;
}

function taskTooltip(task) {
  const lines = [task.title];
  if (task.taxLines && task.taxLines.length > 0) lines.push(task.taxLines.join(' · '));
  if (task.comment) lines.push(`Комментарий: ${task.comment}`);
  if (task.paymentFilled) lines.push('Платёж внесён в реестр');
  return lines.join('\n');
}

function renderTaskChip(task) {
  const chip = document.createElement('div');
  chip.className = `task-chip task-chip--${task.status}`;
  chip.dataset.taskId = task.id;
  chip.dataset.status = task.status;
  chip.title = taskTooltip(task);

  const title = document.createElement('span');
  title.className = 'task-chip__title';
  title.textContent = task.title;

  // Платёж уже внесён в реестр — помечаем плашку (FR-57).
  if (task.paymentFilled) {
    const paid = document.createElement('span');
    paid.className = 'task-chip__paid';
    paid.textContent = '₽';
    paid.title = 'Платёж внесён в реестр';
    chip.appendChild(paid);
  }

  const comment = document.createElement('button');
  comment.type = 'button';
  comment.className = 'task-chip__comment';
  comment.dataset.action = 'comment';
  comment.textContent = '💬';
  comment.setAttribute('aria-label', 'Комментарий');
  comment.title = task.comment ? `Комментарий: ${task.comment}` : 'Добавить комментарий';
  if (task.comment) comment.classList.add('is-active');

  chip.append(title, comment);
  return chip;
}

function renderDayCell(client, day) {
  const cell = document.createElement('td');
  cell.className = 'week-cell';
  cell.dataset.clientId = client.id;
  cell.dataset.date = day;
  if (day === isoToday()) cell.classList.add('is-today');

  for (const task of client.tasks || []) {
    if (task.date === day) cell.appendChild(renderTaskChip(task));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add-task';
  add.dataset.action = 'add-task';
  add.textContent = '+ Добавить задачу';
  cell.appendChild(add);

  return cell;
}

function renderWeek() {
  renderWeekHead();

  const body = $('week-grid-body');
  body.textContent = '';

  if (!weekData || weekData.clients.length === 0) {
    const searchText = $('client-search').value.trim();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'week-grid__empty';
    cell.colSpan = 8;
    cell.textContent = searchText
      ? 'Клиенты не найдены. Измените запрос или очистите строку поиска.'
      : 'Данных пока нет. Заведите первого клиента кнопкой «Добавить клиента».';
    row.appendChild(cell);
    body.appendChild(row);
    updateWeekSummary();
    return;
  }

  for (const client of weekData.clients) {
    const row = document.createElement('tr');
    row.dataset.id = client.id;
    row.appendChild(renderClientCell(client));

    for (const day of weekDays()) row.appendChild(renderDayCell(client, day));
    body.appendChild(row);
  }

  updateWeekSummary();
}

function updateWeekSummary() {
  if (!weekData) return;

  $('clients-count').textContent = `Клиентов: ${weekData.activeClients}`;
  renderClientsMenuCount();

  const summary = weekData.summary;
  $('week-progress').textContent =
    `Прогресс недели: ${summary.progress} % (${summary.done} из ${summary.total}) · отправлено: ${summary.sent}`;
}

// Счётчик на кнопке «Клиенты»: всегда число активных клиентов, как в подвале.
function renderClientsMenuCount() {
  const badge = $('clients-menu-count');
  if (!badge) return;

  const count = weekData ? weekData.activeClients : 0;
  badge.textContent = String(count);
  badge.hidden = !(count > 0);
  badge.title = `Активных клиентов: ${count}`;
  $('btn-clients').title = `Справочник клиентов · активных: ${count}`;
}

async function loadWeek() {
  if (!weekFrom) weekFrom = startOfWeek(isoToday());

  const requestId = ++weekRequestId;
  const from = weekFrom;
  const to = addDays(weekFrom, 6);
  const params = new URLSearchParams({ from, to, mode: currentMode() });

  const searchText = $('client-search').value.trim();
  if (searchText) params.set('search', searchText);

  const result = await api(`/api/week?${params.toString()}`);

  // Пока шёл запрос, пользователь мог переключить неделю или изменить поиск.
  if (requestId !== weekRequestId) return;

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить неделю');
    return;
  }

  weekData = result.data;
  clientsList = weekData.clients || [];
  // Список для фильтров и чек-листов мог устареть после правки клиентов.
  allClientsCache = null;
  renderWeek();
}

function formValues() {
  const vatValue = $('field-vat').value;
  const rateValue = $('field-vat-rate').value;

  return {
    form: $('field-form').value,
    name: $('field-name').value.trim(),
    inn: $('field-inn').value.trim(),
    sno: $('field-sno').value,
    vat: vatValue === '' ? null : vatValue === 'yes',
    vatRate: rateValue === '' ? null : Number(rateValue),
    vatExempt: $('field-vat-exempt').checked,
    profitAdvances: $('field-profit').value,
    hasEmployees: $('field-employees').checked,
    hasLandTax: $('field-land').checked,
    hasPropertyTax: $('field-property').checked,
    hasTransportTax: $('field-transport').checked,
    extraFlags: formFlags,
  };
}

function fillForm(client) {
  $('field-form').value = client ? client.form : '';
  $('field-name').value = client ? client.name : '';
  $('field-inn').value = client ? client.inn : '';
  $('field-sno').value = client ? client.sno : '';
  $('field-vat').value = client ? (client.vat ? 'yes' : 'no') : '';
  $('field-vat-rate').value = client && client.vatRate !== null ? String(client.vatRate) : '';
  $('field-vat-exempt').checked = client ? client.vatExempt : false;
  $('field-profit').value = client ? client.profitAdvances : 'none';
  $('field-employees').checked = client ? client.hasEmployees : false;
  $('field-land').checked = client ? client.hasLandTax : false;
  $('field-property').checked = client ? client.hasPropertyTax : false;
  $('field-transport').checked = client ? client.hasTransportTax : false;

  formFlags = client ? [...client.extraFlags] : [];
  formFlagsChecked = new Set(formFlags);
  $('client-errors').hidden = true;
}

function showClientErrors(errors) {
  const node = $('client-errors');
  node.textContent = '';

  const list = document.createElement('ul');
  for (const error of errors) {
    const item = document.createElement('li');
    item.textContent = error;
    list.appendChild(item);
  }

  node.appendChild(list);
  node.hidden = false;
}

function openClientForm(client) {
  editingClientId = client ? client.id : null;
  $('client-modal-title').textContent = client ? 'Изменить клиента' : 'Добавить клиента';
  fillForm(client);
  $('client-modal').hidden = false;
  $('field-name').focus();
}

function closeClientForm() {
  $('client-modal').hidden = true;
  editingClientId = null;
}

async function submitClientForm(event) {
  event.preventDefault();

  const payload = formValues();
  const result = editingClientId
    ? await api(`/api/clients/${editingClientId}`, { method: 'PATCH', body: JSON.stringify(payload) })
    : await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) });

  if (result.status === 401) {
    showLogin();
    return;
  }

  if (!result.ok) {
    showClientErrors((result.data && result.data.errors) || ['Не удалось сохранить клиента']);
    return;
  }

  closeClientForm();
  await loadWeek();
  if (!$('clients-view').hidden) await loadDirectory();
}

async function setClientProperty(id, patch) {
  await api(`/api/clients/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  await loadWeek();
  if (!$('clients-view').hidden) await loadDirectory();
}

// --- Справочник клиентов (меню «Клиенты») ---
//
// Отдельный экран со всеми клиентами текущего режима: реквизиты, признаки
// и переход в карточку. Данные берутся из /api/clients, а не из недели,
// поэтому в справочник попадают клиенты и без задач на выбранной неделе.

let directoryClients = [];
let directoryRequestId = 0;
// Сортировка справочника: колонка и направление. Пустая колонка — порядок
// как в неделе (закреплённые, ручной порядок, алфавит).
let directorySort = { key: null, dir: 'asc' };

const directoryCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function vatLabel(client) {
  if (client.vat) return `да, ${client.vatRate} %`;
  if (client.vatExempt) return 'освобождён';
  return 'нет';
}

function advancesLabel(client) {
  if (client.profitAdvances === 'monthly') return 'ежемесячно';
  if (client.profitAdvances === 'quarterly') return 'ежеквартально';
  return 'нет';
}

function featuresLabel(client) {
  const parts = [];
  if (client.hasEmployees) parts.push('сотрудники');
  if (client.hasLandTax) parts.push('земельный');
  if (client.hasPropertyTax) parts.push('имущественный');
  if (client.hasTransportTax) parts.push('транспортный');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function directorySortValue(client, key) {
  if (key === 'inn') return client.inn;
  if (key === 'form') return `${client.form} · ${client.sno}`;
  return client.name;
}

// Закреплённые клиенты остаются сверху при любой сортировке: так строка
// недели и справочник показывают их на одном и том же месте.
function sortedDirectoryClients(list) {
  if (!directorySort.key) return list;

  const factor = directorySort.dir === 'desc' ? -1 : 1;
  const key = directorySort.key;

  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const result = directoryCollator.compare(
      directorySortValue(a, key),
      directorySortValue(b, key),
    );
    return result === 0 ? 0 : result * factor;
  });
}

function filteredDirectoryClients() {
  const searchText = $('client-search').value.trim().toLowerCase();
  const list = searchText
    ? directoryClients.filter(
        (client) =>
          client.name.toLowerCase().includes(searchText) ||
          client.inn.toLowerCase().includes(searchText),
      )
    : directoryClients;

  return sortedDirectoryClients(list);
}

// Стрелка в заголовке показывает текущую колонку и направление.
function renderDirectorySort() {
  for (const th of document.querySelectorAll('.clients-table th[data-sort]')) {
    const active = th.dataset.sort === directorySort.key;
    th.classList.toggle('is-sorted', active);
    th.classList.toggle('is-desc', active && directorySort.dir === 'desc');
    th.setAttribute(
      'aria-sort',
      active ? (directorySort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    );
  }
}

function toggleDirectorySort(key) {
  if (directorySort.key === key) {
    directorySort = { key, dir: directorySort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    directorySort = { key, dir: 'asc' };
  }

  if (!$('clients-view').hidden) renderDirectory();
}

function directoryActionButton(title, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = title;
  return button;
}

function renderDirectory() {
  const body = $('clients-body');
  body.textContent = '';

  renderDirectorySort();

  const clients = filteredDirectoryClients();
  const mode = currentMode() === 'archive' ? 'архивные' : 'активные';
  const searchText = $('client-search').value.trim();

  $('clients-hint').textContent = searchText
    ? `Найдено: ${clients.length} из ${directoryClients.length} · режим: ${mode}`
    : `Всего: ${clients.length} · режим: ${mode}`;

  if (clients.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'clients-empty';
    cell.colSpan = 7;
    cell.textContent = searchText
      ? 'Клиенты не найдены. Измените запрос или очистите строку поиска.'
      : currentMode() === 'archive'
        ? 'В архиве клиентов нет.'
        : 'Клиентов пока нет. Заведите первого кнопкой «Добавить клиента».';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  for (const client of clients) {
    const row = document.createElement('tr');
    row.dataset.id = client.id;

    const nameCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'clients-table__name';
    name.textContent = client.name;
    nameCell.appendChild(name);

    if (client.pinned) {
      const pinned = document.createElement('span');
      pinned.className = 'clients-table__pinned';
      pinned.textContent = 'закреплён';
      name.appendChild(pinned);
    }

    if (client.extraFlags.length > 0) {
      const flags = document.createElement('div');
      flags.className = 'clients-table__flags';
      for (const flag of client.extraFlags) {
        const chip = document.createElement('span');
        chip.className = 'clients-flag';
        chip.textContent = flag;
        flags.appendChild(chip);
      }
      nameCell.appendChild(flags);
    }

    const innCell = document.createElement('td');
    innCell.className = 'clients-table__inn';
    innCell.textContent = client.inn;

    const formCell = document.createElement('td');
    formCell.textContent = `${client.form} · ${client.sno}`;

    const vatCell = document.createElement('td');
    vatCell.textContent = vatLabel(client);

    const advancesCell = document.createElement('td');
    advancesCell.textContent = advancesLabel(client);

    const featuresCell = document.createElement('td');
    featuresCell.textContent = featuresLabel(client);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'clients-table__actions';
    actionsCell.append(
      directoryActionButton('Отчётность', 'report'),
      directoryActionButton('Изменить', 'edit'),
      directoryActionButton('На неделе', 'week'),
      directoryActionButton(client.archived ? 'Вернуть' : 'В архив', 'archive'),
      directoryActionButton(client.pinned ? 'Открепить' : 'Закрепить', 'pin'),
    );

    row.append(nameCell, innCell, formCell, vatCell, advancesCell, featuresCell, actionsCell);
    body.appendChild(row);
  }
}

async function loadDirectory() {
  const requestId = ++directoryRequestId;
  const result = await api(`/api/clients?mode=${currentMode()}`);

  if (requestId !== directoryRequestId) return;

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить клиентов');
    return;
  }

  directoryClients = (result.data && result.data.clients) || [];
  renderDirectory();
}

async function openClients() {
  $('registry-view').hidden = true;
  $('deadlines-view').hidden = true;
  $('week-grid').hidden = true;
  $('clients-view').hidden = false;
  await loadDirectory();
}

function closeClients() {
  $('clients-view').hidden = true;
  $('week-grid').hidden = false;
}

// «На неделе»: возвращает на сетку и ставит клиента в строку поиска.
// Архивного клиента показываем в архивном режиме — иначе его там нет.
function showClientOnWeek(client) {
  const mode = client.archived ? 'archive' : 'active';
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);

  if (radio && !radio.checked) {
    radio.checked = true;
    scheduleSettingsSave();
  }

  $('client-search').value = client.name;
  closeClients();
  loadWeek();
}

// Печать справочника: те же строки и тот же порядок, что на экране,
// без колонки действий.
function printDirectoryHtml() {
  const clients = filteredDirectoryClients();
  if (clients.length === 0) {
    return '<p class="print-empty">Клиентов по текущим условиям нет.</p>';
  }

  const mode = currentMode() === 'archive' ? 'архивные' : 'активные';
  const searchText = $('client-search').value.trim();
  const meta = [
    `Режим: ${mode}`,
    searchText ? `Поиск: «${searchText}»` : 'Все клиенты',
    `Клиентов: ${clients.length}`,
    `Печать от ${formatDateRu(isoToday())}`,
  ];

  const rows = clients
    .map((client) => {
      const notes = [];
      if (client.pinned) notes.push('закреплён');
      if (client.extraFlags.length > 0) notes.push(...client.extraFlags);

      const name =
        escapeHtml(client.name) +
        (notes.length > 0
          ? `<div class="print-comment">${escapeHtml(notes.join(' · '))}</div>`
          : '');

      return (
        `<tr><td class="print-client">${name}</td>` +
        `<td class="print-date">${escapeHtml(client.inn)}</td>` +
        `<td>${escapeHtml(`${client.form} · ${client.sno}`)}</td>` +
        `<td>${escapeHtml(vatLabel(client))}</td>` +
        `<td>${escapeHtml(advancesLabel(client))}</td>` +
        `<td>${escapeHtml(featuresLabel(client))}</td></tr>`
      );
    })
    .join('');

  return (
    '<h1>Клиенты</h1>' +
    `<p class="print-meta">${meta.map(escapeHtml).join(' · ')}</p>` +
    '<table class="print-table print-table--clients"><thead><tr>' +
    '<th>Клиент</th><th>ИНН</th><th>Форма · СНО</th><th>НДС</th>' +
    '<th>Авансы по прибыли</th><th>Признаки</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function printDirectory() {
  $('print-area').innerHTML = printDirectoryHtml();
  window.print();
}

// --- Пометки «Дополнительно» ---

function renderFlags() {
  const list = $('flags-list');
  list.textContent = '';

  const items = [...new Set([...builtinFlags, ...formFlags])];

  for (const title of items) {
    const isBuiltin = builtinFlags.includes(title);
    const item = document.createElement('div');
    item.className = 'flags-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = formFlagsChecked.has(title);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) formFlagsChecked.add(title);
      else formFlagsChecked.delete(title);
      formFlags = [...formFlagsChecked];
    });

    const label = document.createElement('span');
    label.className = 'flags-item__title';
    label.textContent = title;

    item.append(checkbox, label);

    if (isBuiltin) {
      const badge = document.createElement('span');
      badge.className = 'flags-item__badge';
      badge.textContent = 'готовый';
      item.appendChild(badge);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => {
        formFlagsChecked.delete(title);
        formFlags = [...formFlagsChecked];
        renderFlags();
      });
      item.appendChild(remove);
    }

    list.appendChild(item);
  }
}

async function openFlags() {
  if (builtinFlags.length === 0) {
    const result = await api('/api/flags/builtin');
    builtinFlags = (result.data && result.data.flags) || [];
  }

  renderFlags();
  $('flags-modal').hidden = false;
}

function closeFlags() {
  $('flags-modal').hidden = true;
}

function addFlag() {
  const input = $('flags-new');
  const title = input.value.trim();
  if (!title) return;

  formFlagsChecked.add(title);
  formFlags = [...formFlagsChecked];
  input.value = '';
  renderFlags();
}

// --- Генерация отчётности ---

let reportClient = null;
let reportData = null;
let reportSelected = new Set();

function renderReport() {
  const container = $('report-groups');
  container.textContent = '';

  const total = reportData.totals.all;

  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'report-empty';
    empty.textContent = 'Для этого клиента в горизонте генерации задач нет.';
    container.appendChild(empty);
    updateReportCount();
    return;
  }

  for (const group of reportData.groups) {
    if (group.items.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'report-group';

    const title = document.createElement('h3');
    title.className = 'report-group__title';
    title.textContent = `${group.title} — ${group.items.length}`;
    section.appendChild(title);

    for (const item of group.items) {
      const row = document.createElement('label');
      row.className = 'report-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = reportSelected.has(item.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) reportSelected.add(item.key);
        else reportSelected.delete(item.key);
        updateReportCount();
      });

      const date = document.createElement('span');
      date.className = 'report-item__date';
      date.textContent = formatDateRu(item.date);

      const body = document.createElement('span');
      body.className = 'report-item__body';

      const name = document.createElement('span');
      name.className = 'report-item__title';
      name.textContent = item.title;
      body.appendChild(name);

      if (item.existing) {
        const badge = document.createElement('span');
        badge.className = 'report-item__existing';
        badge.textContent = 'уже создана';
        body.appendChild(badge);
      }

      const lines = item.components && item.components.length > 0
        ? item.components.map((component) => component.label).join(' · ')
        : (item.taxLines || []).join(' · ');

      if (lines) {
        const details = document.createElement('span');
        details.className = 'report-item__lines';
        details.textContent = lines;
        body.appendChild(details);
      }

      row.append(checkbox, date, body);
      section.appendChild(row);
    }

    container.appendChild(section);
  }

  updateReportCount();
}

function updateReportCount() {
  const total = reportData ? reportData.totals.all : 0;
  $('report-count').textContent = `Выбрано: ${reportSelected.size} из ${total}`;
  $('report-submit').disabled = reportSelected.size === 0;
}

async function openReport(client) {
  const result = await api(`/api/clients/${client.id}/report/preview`);

  if (result.status === 401) {
    showLogin();
    return;
  }

  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось построить список задач');
    return;
  }

  reportClient = client;
  reportData = result.data;
  reportSelected = new Set();

  for (const group of reportData.groups) {
    for (const item of group.items) reportSelected.add(item.key);
  }

  $('report-title').textContent = `Создать отчётность — ${client.name}`;
  $('report-hint').textContent =
    `Горизонт: ${formatDateRu(reportData.horizon.from)} — ${formatDateRu(reportData.horizon.to)}. ` +
    `Позиций: ${reportData.totals.all}, дат: ${reportData.totals.dates}. ` +
    'Снимите отметку с тех позиций, которые создавать не нужно.';

  renderReport();
  $('report-modal').hidden = false;
}

function closeReport() {
  $('report-modal').hidden = true;
  reportClient = null;
  reportData = null;
  reportSelected = new Set();
}

function selectAllReport() {
  for (const group of reportData.groups) {
    for (const item of group.items) reportSelected.add(item.key);
  }
  renderReport();
}

function clearReportSelection() {
  reportSelected = new Set();
  renderReport();
}

async function submitReport() {
  if (!reportClient || !reportData || reportSelected.size === 0) return;

  const button = $('report-submit');
  button.disabled = true;

  try {
    const result = await api(`/api/clients/${reportClient.id}/report`, {
      method: 'POST',
      body: JSON.stringify({ keys: [...reportSelected] }),
    });

    if (result.status === 401) {
      showLogin();
      return;
    }

    if (!result.ok) {
      alert((result.data && result.data.error) || 'Не удалось создать задачи');
      return;
    }

    const clientName = reportClient.name;
    const summary = result.data;

    closeReport();
    await loadWeek();

    alert(
      `Клиент: ${clientName}\n` +
      `Создано задач: ${summary.created}\n` +
      `Уже было: ${summary.existing}`,
    );
  } finally {
    button.disabled = false;
  }
}

// --- Сетка недели: задачи, статусы, комментарии, каталог шаблонов ---

let menuTaskId = null;
let commentTaskId = null;
let catalogClientId = null;
let catalogDate = null;
let catalogTemplates = [];
let catalogSelected = new Set();

function findTaskById(taskId) {
  if (!weekData) return null;
  for (const client of weekData.clients || []) {
    const task = (client.tasks || []).find((item) => item.id === taskId);
    if (task) return task;
  }
  return null;
}

function hideTaskMenus() {
  $('status-menu').hidden = true;
  $('task-menu').hidden = true;
  menuTaskId = null;
}

function placeFloatingMenu(menu, x, y) {
  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';

  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  const top = y + height + 8 > window.innerHeight
    ? Math.max(8, y - height - 8)
    : y;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Меню статуса из четырёх значений; прямого цикла по клику нет (FR-32).
function showStatusMenu(taskId, anchor) {
  const task = findTaskById(taskId);
  if (!task) return;

  hideTaskMenus();
  menuTaskId = taskId;

  const menu = $('status-menu');
  menu.textContent = '';

  const title = document.createElement('div');
  title.className = 'floating-menu__title';
  title.textContent = task.title;
  menu.appendChild(title);

  for (const status of STATUSES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `status-option status-option--${status.id}`;
    if (task.status === status.id) button.classList.add('is-current');
    button.textContent = status.label;
    button.addEventListener('click', () => setTaskStatus(taskId, status.id));
    menu.appendChild(button);
  }

  // «Заполнить платежи» — только для задач с уплатой (FR-57, FR-65).
  if (task.paymentEligible) {
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'menu-action';
    fill.textContent = task.paymentFilled ? 'Изменить платежи' : 'Заполнить платежи';
    fill.addEventListener('click', () => {
      hideTaskMenus();
      openPaymentForm(taskId);
    });
    menu.appendChild(fill);
  }

  const rect = anchor.getBoundingClientRect();
  placeFloatingMenu(menu, rect.left, rect.bottom + 4);
}

async function setTaskStatus(taskId, status) {
  hideTaskMenus();

  const result = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось изменить статус');
    return;
  }

  await loadWeek();
}

// Правый клик по плашке: пункт «Удалить задачу» (FR-34).
function showTaskMenu(taskId, x, y) {
  const task = findTaskById(taskId);
  if (!task) return;

  hideTaskMenus();
  menuTaskId = taskId;

  const menu = $('task-menu');
  menu.textContent = '';

  const title = document.createElement('div');
  title.className = 'floating-menu__title';
  title.textContent = task.title;
  menu.appendChild(title);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'menu-danger';
  remove.textContent = 'Удалить задачу';
  remove.addEventListener('click', () => deleteTask(taskId));
  menu.appendChild(remove);

  placeFloatingMenu(menu, x, y);
}

async function deleteTask(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;

  hideTaskMenus();
  if (!confirm(`Удалить задачу «${task.title}»?`)) return;

  const result = await api(`/api/tasks/${taskId}`, { method: 'DELETE' });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось удалить задачу');
    return;
  }

  await loadWeek();
}

// Комментарий хранится в задаче и не влияет на генерацию (FR-35, FR-36).
function openComment(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;

  hideTaskMenus();
  commentTaskId = taskId;

  const client = (weekData.clients || []).find((item) => item.id === task.clientId);
  $('comment-title').textContent = 'Комментарий к задаче';
  $('comment-task').textContent =
    `${formatDateRu(task.date)} · ${client ? client.name : ''} · ${task.title}`;
  $('comment-text').value = task.comment || '';
  $('comment-modal').hidden = false;
  $('comment-text').focus();
}

function closeComment() {
  $('comment-modal').hidden = true;
  commentTaskId = null;
}

async function saveComment(comment) {
  if (!commentTaskId) return;

  const result = await api(`/api/tasks/${commentTaskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ comment }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось сохранить комментарий');
    return;
  }

  closeComment();
  await loadWeek();
}

// --- Каталог шаблонов (FR-27…FR-31) ---

function updateCatalogCount() {
  $('catalog-count').textContent =
    `Выбрано: ${catalogSelected.size} из ${catalogTemplates.length}`;
  $('catalog-submit').disabled = catalogSelected.size === 0;
}

function renderCatalog() {
  const list = $('catalog-list');
  list.textContent = '';

  if (catalogTemplates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'catalog-empty';
    empty.textContent = 'Шаблонов пока нет. Добавьте первый шаблон ниже.';
    list.appendChild(empty);
  }

  for (const template of catalogTemplates) {
    const row = document.createElement('div');
    row.className = 'catalog-item';

    const main = document.createElement('label');
    main.className = 'catalog-item__main';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = catalogSelected.has(template.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) catalogSelected.add(template.id);
      else catalogSelected.delete(template.id);
      updateCatalogCount();
    });

    const title = document.createElement('span');
    title.className = 'catalog-item__title';
    title.textContent = template.title;

    main.append(checkbox, title);
    row.appendChild(main);

    if (template.builtin) {
      const badge = document.createElement('span');
      badge.className = 'catalog-item__badge';
      badge.textContent = 'встроенный';
      row.appendChild(badge);
    } else {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'catalog-item__action';
      rename.textContent = 'Переименовать';
      rename.addEventListener('click', () => renameCatalogTemplate(template));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'catalog-item__action catalog-item__action--danger';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => deleteCatalogTemplate(template));

      row.append(rename, remove);
    }

    list.appendChild(row);
  }

  updateCatalogCount();
}

async function reloadCatalogTemplates() {
  const result = await api('/api/templates');

  if (result.status === 401) {
    showLogin();
    return false;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить шаблоны');
    return false;
  }

  catalogTemplates = result.data.templates || [];
  renderCatalog();
  return true;
}

async function openCatalog(clientId, day) {
  const client = clientsList.find((item) => item.id === clientId);
  if (!client) return;

  hideTaskMenus();
  catalogClientId = clientId;
  catalogDate = day;
  catalogSelected = new Set();
  $('catalog-title').textContent = 'Добавить задачу';
  $('catalog-hint').textContent =
    `${client.name} · ${formatDateRu(day)}. Отметьте шаблоны или создайте свою задачу.`;
  $('catalog-new-title').value = '';
  $('manual-title').value = '';

  const loaded = await reloadCatalogTemplates();
  if (!loaded) return;

  $('catalog-modal').hidden = false;
}

function closeCatalog() {
  $('catalog-modal').hidden = true;
  catalogClientId = null;
  catalogDate = null;
  catalogSelected = new Set();
}

async function addCatalogTemplate() {
  const input = $('catalog-new-title');
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }

  const result = await api('/api/templates', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось добавить шаблон');
    return;
  }

  input.value = '';
  const created = result.data.template;
  const loaded = await reloadCatalogTemplates();
  if (!loaded) return;

  catalogSelected.add(created.id);
  renderCatalog();
}

async function renameCatalogTemplate(template) {
  const next = prompt('Новое название шаблона', template.title);
  if (next === null) return;

  const title = next.trim();
  if (!title || title === template.title) return;

  const result = await api(`/api/templates/${template.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось переименовать шаблон');
    return;
  }

  await reloadCatalogTemplates();
}

async function deleteCatalogTemplate(template) {
  if (!confirm(`Удалить шаблон «${template.title}»?`)) return;

  const result = await api(`/api/templates/${template.id}`, { method: 'DELETE' });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось удалить шаблон');
    return;
  }

  catalogSelected.delete(template.id);
  await reloadCatalogTemplates();
}

async function submitCatalog() {
  if (!catalogClientId || catalogSelected.size === 0) return;

  const button = $('catalog-submit');
  button.disabled = true;

  try {
    const result = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        clientId: catalogClientId,
        date: catalogDate,
        templateIds: [...catalogSelected],
      }),
    });

    if (result.status === 401) {
      showLogin();
      return;
    }
    if (!result.ok) {
      alert((result.data && result.data.error) || 'Не удалось создать задачи');
      return;
    }

    closeCatalog();
    await loadWeek();
  } finally {
    button.disabled = false;
  }
}

async function addManualTask() {
  if (!catalogClientId) return;

  const input = $('manual-title');
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }

  const button = $('manual-add-btn');
  button.disabled = true;

  try {
    const result = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ clientId: catalogClientId, date: catalogDate, title }),
    });

    if (result.status === 401) {
      showLogin();
      return;
    }
    if (!result.ok) {
      alert((result.data && result.data.error) || 'Не удалось создать задачу');
      return;
    }

    closeCatalog();
    await loadWeek();
  } finally {
    button.disabled = false;
  }
}

// --- Реестр платежей (разделы 5.1 и 6.9 ТЗ, FR-57…FR-66) ---

const SOURCE_LABELS = {
  notification: 'уведомление',
  declaration: 'декларация',
  manual: 'вручную',
};

let registryData = null;
let paymentClientId = null;
let paymentTaskId = null;
let paymentVat = null;
let paymentVatSplit = false;
let paymentProfit = null;
let paymentProfitFix = false;

// Суммы — целые рубли, на экране с разрядами (FR-66).
function money(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ДД-ММ-ГГГГ → ГГГГ-ММ-ДД. Пустой или неверный текст — null.
function parseRuDate(text) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(text).trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function parseAmount(text) {
  const trimmed = String(text).trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

// --- Выбор даты из календаря ---
// Своё мини-окно календаря для всех полей дат: без внешних библиотек
// и без изменения формата ввода ДД-ММ-ГГГГ (NFR-08).

let pickerInput = null;
let pickerYear = null;
let pickerMonth = null; // 1…12

function openDatePicker(anchor, input) {
  pickerInput = input;
  const iso = parseRuDate(input.value) || isoToday();
  const [year, month] = iso.split('-').map(Number);
  pickerYear = year;
  pickerMonth = month;
  renderDatePicker();

  const rect = anchor.getBoundingClientRect();
  placeFloatingMenu($('date-picker'), rect.left, rect.bottom + 4);
}

function renderDatePicker() {
  const node = $('date-picker');
  node.textContent = '';

  const head = document.createElement('div');
  head.className = 'date-picker__head';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'date-picker__nav';
  prev.dataset.step = '-1';
  prev.textContent = '◀';

  const label = document.createElement('span');
  label.className = 'date-picker__label';
  label.textContent = `${MONTHS[pickerMonth - 1]} ${pickerYear}`;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'date-picker__nav';
  next.dataset.step = '1';
  next.textContent = '▶';

  head.append(prev, label, next);
  node.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'date-picker__grid';

  for (const name of WEEKDAYS) {
    const cell = document.createElement('span');
    cell.className = 'date-picker__weekday';
    cell.textContent = name;
    grid.appendChild(cell);
  }

  // Месяц рисуется с понедельника; пустые ячейки — до первого дня.
  const firstWeekday = new Date(Date.UTC(pickerYear, pickerMonth - 1, 1)).getUTCDay();
  const offset = (firstWeekday + 6) % 7;
  const total = new Date(Date.UTC(pickerYear, pickerMonth, 0)).getUTCDate();
  const selected = pickerInput ? parseRuDate(pickerInput.value) : null;

  for (let i = 0; i < offset; i += 1) grid.appendChild(document.createElement('span'));

  for (let day = 1; day <= total; day += 1) {
    const iso = `${pickerYear}-${String(pickerMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-picker__day';
    button.dataset.date = iso;
    button.textContent = String(day);
    if (iso === isoToday()) button.classList.add('is-today');
    if (iso === selected) button.classList.add('is-selected');
    grid.appendChild(button);
  }

  node.appendChild(grid);
}

function closeDatePicker() {
  $('date-picker').hidden = true;
  pickerInput = null;
}

// --- Экран реестра: группировка по дате, фильтры, итоги (FR-62, FR-63) ---

let registryClients = null;

// Список организаций для фильтра: и активные, и архивные — платежи
// остаются и после отправки клиента в архив (FR-14).
async function ensureRegistryClients() {
  if (registryClients) return true;

  const active = await api('/api/clients?mode=active');
  const archive = await api('/api/clients?mode=archive');
  if (active.status === 401 || archive.status === 401) {
    showLogin();
    return false;
  }
  if (!active.ok || !archive.ok) return false;

  registryClients = [...(active.data.clients || []), ...(archive.data.clients || [])]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const select = $('registry-client');
  const current = select.value;
  select.textContent = '';

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'все';
  select.appendChild(all);

  for (const client of registryClients) {
    const option = document.createElement('option');
    option.value = client.id;
    option.textContent = client.name;
    select.appendChild(option);
  }

  if ([...select.options].some((option) => option.value === current)) select.value = current;
  return true;
}

async function loadRegistry() {
  const params = new URLSearchParams();

  const clientId = $('registry-client').value;
  if (clientId) params.set('clientId', clientId);

  for (const [id, key] of [['registry-from', 'from'], ['registry-to', 'to']]) {
    const text = $(id).value.trim();
    if (!text) continue;
    const iso = parseRuDate(text);
    if (!iso) {
      alert(`Дата в поле «${key === 'from' ? 'С' : 'По'}» должна быть в формате ДД-ММ-ГГГГ`);
      return;
    }
    params.set(key, iso);
  }

  const taxKind = $('registry-tax').value;
  if (taxKind) params.set('taxKind', taxKind);

  const result = await api(`/api/payments?${params.toString()}`);

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить реестр');
    return;
  }

  registryData = result.data;
  renderRegistry();
}

async function openRegistry() {
  $('deadlines-view').hidden = true;
  $('clients-view').hidden = true;
  $('week-grid').hidden = true;
  $('registry-view').hidden = false;
  if (await ensureRegistryClients()) await loadRegistry();
}

function closeRegistry() {
  $('registry-view').hidden = true;
  $('week-grid').hidden = false;
}

function renderRegistryTaxFilter() {
  const select = $('registry-tax');
  const current = select.value;
  select.textContent = '';

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'все';
  select.appendChild(all);

  for (const kind of registryData.taxKinds || []) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    select.appendChild(option);
  }

  if ((registryData.taxKinds || []).includes(current)) select.value = current;
}

function paymentLineText(line) {
  const filing = line.filingDate ? ` · сдано ${formatDateRu(line.filingDate)}` : '';
  return `${line.taxKind} — ${money(line.amount)} ₽ · ${SOURCE_LABELS[line.source] || line.source}${filing}`;
}

function renderRegistry() {
  renderRegistryTaxFilter();

  const body = $('registry-body');
  body.textContent = '';

  const payments = registryData.payments || [];

  if (payments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'registry-empty';
    empty.textContent = 'Записей нет. Платежи вносятся из задач кнопкой «Заполнить платежи» или вручную.';
    body.appendChild(empty);
  }

  // Платежи уже отсортированы по дате — собираем группы по дате.
  const byDate = new Map();
  for (const payment of payments) {
    if (!byDate.has(payment.paymentDate)) byDate.set(payment.paymentDate, []);
    byDate.get(payment.paymentDate).push(payment);
  }

  const dateTotals = new Map(
    (registryData.totals.byDate || []).map((entry) => [entry.date, entry.total]),
  );

  for (const [date, group] of byDate) {
    const section = document.createElement('div');
    section.className = 'registry-date';

    const head = document.createElement('div');
    head.className = 'registry-date__head';
    const label = document.createElement('span');
    label.className = 'registry-date__label';
    label.textContent = formatDateRu(date);
    const total = document.createElement('span');
    total.className = 'registry-date__total';
    total.textContent = `Итого за дату: ${money(dateTotals.get(date) || 0)} ₽`;
    head.append(label, total);
    section.appendChild(head);

    for (const payment of group) {
      const row = document.createElement('div');
      row.className = 'registry-row';

      const info = document.createElement('div');
      info.className = 'registry-row__info';

      const client = document.createElement('div');
      client.className = 'registry-row__client';
      client.textContent = payment.clientName + (payment.manual ? ' · запись вручную' : '');
      info.appendChild(client);

      for (const line of payment.lines) {
        const lineNode = document.createElement('div');
        lineNode.className = 'registry-row__line';
        lineNode.textContent = paymentLineText(line);
        info.appendChild(lineNode);
      }

      if (payment.comment) {
        const comment = document.createElement('div');
        comment.className = 'registry-row__comment';
        comment.textContent = `Комментарий: ${payment.comment}`;
        info.appendChild(comment);
      }

      const sum = document.createElement('div');
      sum.className = 'registry-row__sum';
      sum.textContent = `${money(payment.total)} ₽`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'registry-row__remove';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => deletePayment(payment.id));

      row.append(info, sum, remove);
      section.appendChild(row);
    }

    body.appendChild(section);
  }

  renderRegistrySummary();
}

function renderRegistrySummary() {
  const summary = $('registry-summary');
  summary.textContent = '';

  const byClient = (registryData.totals && registryData.totals.byClient) || [];
  if (byClient.length === 0) return;

  const title = document.createElement('div');
  title.className = 'registry-summary__title';
  title.textContent = 'Итоги по клиентам';
  summary.appendChild(title);

  for (const entry of byClient) {
    const row = document.createElement('div');
    row.className = 'registry-summary__row';
    const name = document.createElement('span');
    name.textContent = entry.name;
    const total = document.createElement('span');
    total.textContent = `${money(entry.total)} ₽`;
    row.append(name, total);
    summary.appendChild(row);
  }

  const grand = document.createElement('div');
  grand.className = 'registry-summary__grand';
  grand.textContent = `Всего: ${money(registryData.totals.grand)} ₽`;
  summary.appendChild(grand);
}

async function deletePayment(id) {
  if (!confirm('Удалить запись реестра?')) return;

  const result = await api(`/api/payments/${id}`, { method: 'DELETE' });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось удалить запись');
    return;
  }

  await loadWeek();
  if (!$('registry-view').hidden) await loadRegistry();
}

// --- Форма «Заполнить платежи» (FR-57…FR-61, FR-66) ---

function paymentLineRow(line) {
  const row = document.createElement('tr');

  const taxCell = document.createElement('td');
  const tax = document.createElement('input');
  tax.type = 'text';
  tax.className = 'payment-tax';
  tax.setAttribute('list', 'tax-kinds');
  tax.maxLength = 100;
  tax.value = line.taxKind || '';
  taxCell.appendChild(tax);

  const amountCell = document.createElement('td');
  const amount = document.createElement('input');
  amount.type = 'text';
  amount.className = 'payment-amount';
  amount.inputMode = 'numeric';
  amount.value = line.amount ? String(line.amount) : '';
  amount.addEventListener('input', updatePaymentTotal);
  amountCell.appendChild(amount);

  const sourceCell = document.createElement('td');
  const source = document.createElement('select');
  source.className = 'payment-source';
  for (const id of Object.keys(SOURCE_LABELS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = SOURCE_LABELS[id];
    source.appendChild(option);
  }
  source.value = SOURCE_LABELS[line.source] ? line.source : 'manual';
  sourceCell.appendChild(source);

  const filingCell = document.createElement('td');
  const filingField = document.createElement('span');
  filingField.className = 'date-field';
  const filing = document.createElement('input');
  filing.type = 'text';
  filing.className = 'payment-filing';
  filing.placeholder = 'ДД-ММ-ГГГГ';
  filing.maxLength = 10;
  filing.value = line.filingDate ? formatDateRu(line.filingDate) : '';
  const filingPick = document.createElement('button');
  filingPick.type = 'button';
  filingPick.className = 'date-pick';
  filingPick.title = 'Выбрать дату';
  filingPick.textContent = '📅';
  filingField.append(filing, filingPick);
  filingCell.appendChild(filingField);

  const removeCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'payment-line-remove';
  remove.textContent = '✕';
  remove.title = 'Удалить строку';
  remove.addEventListener('click', () => {
    row.remove();
    updatePaymentTotal();
  });
  removeCell.appendChild(remove);

  row.append(taxCell, amountCell, sourceCell, filingCell, removeCell);
  return row;
}

function renderPaymentLines(lines) {
  const body = $('payment-lines-body');
  body.textContent = '';
  for (const line of lines) body.appendChild(paymentLineRow(line));
  updatePaymentTotal();
}

function addPaymentLine() {
  $('payment-lines-body').appendChild(
    paymentLineRow({ taxKind: '', amount: 0, source: 'manual', filingDate: null }),
  );
}

// Итог считается из строк и отдельно не вводится (FR-60).
function updatePaymentTotal() {
  let total = 0;
  for (const input of document.querySelectorAll('#payment-lines-body .payment-amount')) {
    const value = parseAmount(input.value);
    if (value !== null && value > 0) total += value;
  }
  $('payment-total').textContent = money(total);
}

function openPaymentModal() {
  $('payment-modal').hidden = false;
  $('payment-date').focus();
}

function closePaymentForm() {
  $('payment-modal').hidden = true;
  paymentClientId = null;
  paymentTaskId = null;
  paymentVat = null;
  paymentVatSplit = false;
  paymentProfit = null;
  paymentProfitFix = false;
  $('vat-split-hint').textContent = '';
  $('profit-split-hint').textContent = '';
}

// Открывается из карточки задачи: строки приходят с сервера — уведомление
// даёт строку на каждый налог, платёжная задача — одну строку (раздел 5.1).
async function openPaymentForm(taskId) {
  const result = await api(`/api/tasks/${taskId}/payment`);

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось открыть форму платежа');
    return;
  }

  const form = result.data;
  const client = (weekData.clients || []).find((item) => item.id === form.task.clientId);

  paymentClientId = form.task.clientId;
  paymentTaskId = taskId;
  paymentVat = form.vat;
  paymentVatSplit = false;
  paymentProfit = form.profit;
  paymentProfitFix = false;

  $('payment-title').textContent = form.existing ? 'Изменить платежи' : 'Заполнить платежи';
  $('payment-task').textContent =
    `${formatDateRu(form.task.date)} · ${client ? client.name : ''} · ${form.task.title}`;
  $('payment-client').closest('label').hidden = true;
  $('payment-date').value = formatDateRu(form.paymentDate);
  $('payment-comment').value = form.comment || '';
  $('vat-split').hidden = !form.vat;
  $('vat-amount').value = '';
  $('vat-split-hint').textContent = '';
  $('profit-split').hidden = !form.profit;
  $('profit-amount').value = '';
  $('profit-split-hint').textContent = '';

  renderPaymentLines(form.lines);
  openPaymentModal();
}

// Ручная запись без задачи — для травматизма и транспортного налога (FR-64).
async function openManualPayment() {
  const result = await api('/api/clients?mode=active');

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить клиентов');
    return;
  }

  paymentClientId = null;
  paymentTaskId = null;
  paymentVat = null;
  paymentVatSplit = false;
  paymentProfit = null;
  paymentProfitFix = false;

  const select = $('payment-client');
  select.textContent = '';
  for (const client of result.data.clients || []) {
    const option = document.createElement('option');
    option.value = client.id;
    option.textContent = client.name;
    select.appendChild(option);
  }

  $('payment-title').textContent = 'Запись реестра вручную';
  $('payment-task').textContent =
    'Без привязки к задаче: для взносов на травматизм и транспортного налога (FR-64).';
  $('payment-client').closest('label').hidden = false;
  $('payment-date').value = formatDateRu(isoToday());
  $('payment-comment').value = '';
  $('vat-split').hidden = true;

  renderPaymentLines([{ taxKind: '', amount: 0, source: 'manual', filingDate: null }]);
  openPaymentModal();
}

// Деление суммы НДС на три доли (FR-66): остаток идёт в третью долю.
async function splitVat() {
  const amount = parseAmount($('vat-amount').value);
  if (amount === null || amount < 0) {
    alert('Введите целую сумму в рублях');
    return;
  }

  const result = await api('/api/payments/vat-shares', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось разделить сумму');
    return;
  }

  const shares = result.data.shares;
  const dates = (paymentVat && paymentVat.dates || [])
    .map((date) => (date ? formatDateRu(date) : '—'))
    .join(', ');
  $('vat-split-hint').textContent =
    `Доли: ${shares.map(money).join(' / ')} (${dates}) — при сохранении зафиксируются все три срока`;
  paymentVatSplit = true;

  // Сумма для этой задачи — её доля из трёх.
  const rows = document.querySelectorAll('#payment-lines-body tr');
  if (paymentVat && rows.length === 1) {
    rows[0].querySelector('.payment-amount').value = String(shares[paymentVat.share - 1]);
    updatePaymentTotal();
  }
}

// Фиксация авансов по прибыли (раздел 8.4): сумма месяца заполняется
// один раз и повторяется на каждый из трёх сроков. Отличие от НДС:
// там квартальная сумма делится на три, здесь сумма не делится.
function fixProfitAdvances() {
  const amount = parseAmount($('profit-amount').value);
  if (amount === null || amount < 0) {
    alert('Введите целую сумму аванса в рублях');
    return;
  }

  const dates = (paymentProfit && paymentProfit.dates || [])
    .map((date) => formatDateRu(date))
    .join(', ');
  $('profit-split-hint').textContent =
    `Авансы: ${money(amount)} × 3 (${dates}) — при сохранении зафиксируются все сроки`;
  paymentProfitFix = true;

  const rows = document.querySelectorAll('#payment-lines-body tr');
  if (rows.length === 1) {
    rows[0].querySelector('.payment-amount').value = String(amount);
    updatePaymentTotal();
  }
}

// Сохранение авансов по прибыли: по записи на каждый срок группы.
async function saveProfitAdvances(replace) {
  const amount = parseAmount($('profit-amount').value);
  if (amount === null || amount < 0) {
    alert('Введите целую сумму аванса в рублях');
    return;
  }

  const lines = collectPaymentLines();
  if (lines === null) return;

  const result = await api('/api/payments/profit-advances', {
    method: 'POST',
    body: JSON.stringify({
      taskId: paymentTaskId,
      amount,
      comment: $('payment-comment').value,
      filingDate: lines[0] ? lines[0].filingDate : null,
      replace: replace === true,
    }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  // Повторное заполнение требует подтверждения (FR-61).
  if (result.status === 409) {
    if (confirm('По части сроков авансов записи уже есть. Заменить их строки?')) {
      await saveProfitAdvances(true);
    }
    return;
  }

  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось зафиксировать авансы');
    return;
  }

  closePaymentForm();
  await loadWeek();
  if (!$('registry-view').hidden) await loadRegistry();
}

function collectPaymentLines() {
  const lines = [];

  for (const row of document.querySelectorAll('#payment-lines-body tr')) {
    const filingText = row.querySelector('.payment-filing').value.trim();
    let filingDate = null;

    if (filingText) {
      filingDate = parseRuDate(filingText);
      if (!filingDate) {
        alert('Дата сдачи в строке должна быть в формате ДД-ММ-ГГГГ');
        return null;
      }
    }

    lines.push({
      taxKind: row.querySelector('.payment-tax').value.trim(),
      amount: parseAmount(row.querySelector('.payment-amount').value),
      source: row.querySelector('.payment-source').value,
      filingDate,
    });
  }

  return lines;
}

// Сохранение всех трёх долей НДС: по записи на каждый срок квартала.
async function saveVatInstallments(replace) {
  const amount = parseAmount($('vat-amount').value);
  if (amount === null || amount < 0) {
    alert('Введите целую сумму НДС за квартал');
    return;
  }

  const lines = collectPaymentLines();
  if (lines === null) return;

  const result = await api('/api/payments/vat-installments', {
    method: 'POST',
    body: JSON.stringify({
      taskId: paymentTaskId,
      amount,
      comment: $('payment-comment').value,
      filingDate: lines[0] ? lines[0].filingDate : null,
      replace: replace === true,
    }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  // Повторное заполнение требует подтверждения (FR-61).
  if (result.status === 409) {
    if (confirm('По части сроков НДС записи уже есть. Заменить их строки?')) {
      await saveVatInstallments(true);
    }
    return;
  }

  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось зафиксировать доли НДС');
    return;
  }

  closePaymentForm();
  await loadWeek();
  if (!$('registry-view').hidden) await loadRegistry();
}

async function savePayment(replace) {
  // Фиксация всех трёх долей НДС сразу (FR-66): записи реестра
  // создаются на все три срока уплаты квартала с суммами долей.
  if (paymentTaskId && paymentVat && paymentVatSplit) {
    await saveVatInstallments(replace);
    return;
  }

  // Фиксация авансов по прибыли на три месяца: сумма месяца
  // повторяется на каждый срок (раздел 8.4).
  if (paymentTaskId && paymentProfit && paymentProfitFix) {
    await saveProfitAdvances(replace);
    return;
  }

  const paymentDate = parseRuDate($('payment-date').value);
  if (!paymentDate) {
    alert('Дата платежа должна быть в формате ДД-ММ-ГГГГ');
    return;
  }

  const lines = collectPaymentLines();
  if (lines === null) return;

  const payload = {
    // В форме по задаче клиент известен из задачи, в ручной записи —
    // выбирается в списке.
    clientId: paymentTaskId ? paymentClientId : $('payment-client').value,
    paymentDate,
    taskId: paymentTaskId,
    comment: $('payment-comment').value,
    replace: replace === true,
    lines,
  };

  const result = await api('/api/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  // Повторное заполнение требует подтверждения (FR-61): при отказе
  // данные не изменяются — повторный запрос не отправляется.
  if (result.status === 409) {
    if (confirm('По клиенту на эту дату запись уже есть. Заменить её строки?')) {
      await savePayment(true);
    }
    return;
  }

  if (!result.ok) {
    alert((result.data && result.data.errors && result.data.errors.join('\n'))
      || (result.data && result.data.error)
      || 'Не удалось сохранить платёж');
    return;
  }

  closePaymentForm();
  await loadWeek();
  if (!$('registry-view').hidden) await loadRegistry();
}

// --- Фронтенд этапа 7: поиск, фильтры, чек-листы, печать ---

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusLabel(id) {
  const status = STATUSES.find((item) => item.id === id);
  return status ? status.label : id;
}

// Общий список клиентов для фильтров и чек-листов: и активные, и архивные.
let allClientsCache = null;

async function loadAllClients() {
  if (allClientsCache) return allClientsCache;

  const [active, archive] = await Promise.all([
    api('/api/clients?mode=active'),
    api('/api/clients?mode=archive'),
  ]);

  if (active.status === 401 || archive.status === 401) {
    showLogin();
    return null;
  }
  if (!active.ok || !archive.ok) return null;

  allClientsCache = [...(active.data.clients || []), ...(archive.data.clients || [])]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return allClientsCache;
}

function fillClientSelect(select, clients, allLabel) {
  const current = select.value;
  select.textContent = '';

  if (allLabel) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = allLabel;
    select.appendChild(option);
  }

  for (const client of clients) {
    const option = document.createElement('option');
    option.value = client.id;
    option.textContent = client.name;
    select.appendChild(option);
  }

  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

// --- Фильтры: четыре режима и результаты (FR-37…FR-41) ---

let filterMode = 'tasks';
let filterResults = [];
let filterRequestId = 0;

function setFilterMode(mode) {
  filterMode = ['tasks', 'client', 'date', 'status'].includes(mode) ? mode : 'tasks';

  for (const tab of document.querySelectorAll('.filter-tab')) {
    tab.classList.toggle('is-active', tab.dataset.filterMode === filterMode);
  }
  for (const panel of document.querySelectorAll('[data-filter-panel]')) {
    panel.hidden = panel.dataset.filterPanel !== filterMode;
  }
}

async function openFilters() {
  const clients = await loadAllClients();
  if (!clients) {
    alert('Не удалось загрузить клиентов');
    return;
  }

  fillClientSelect($('filter-client'), clients, 'все клиенты');
  setFilterMode(filterMode);
  $('filters-modal').hidden = false;
  if (filterMode === 'tasks') $('filter-task-query').focus();
}

function closeFilters() {
  $('filters-modal').hidden = true;
}

function resetFilters() {
  filterRequestId += 1;
  $('filter-task-query').value = '';
  $('filter-client').value = '';
  $('filter-from').value = '';
  $('filter-to').value = '';
  $('filter-status').value = '';
  filterResults = [];
  $('filter-count').textContent = '';
  $('filter-results').textContent = '';
  setFilterMode('tasks');
}

function renderFilterResults(data) {
  const body = $('filter-results');
  body.textContent = '';
  filterResults = data.tasks || [];

  $('filter-count').textContent = data.total > 0
    ? `Найдено: ${data.total}${data.truncated ? `, показано ${data.shown}` : ''}`
    : 'Ничего не найдено';

  if (filterResults.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'filter-empty';
    empty.textContent = 'По выбранному условию задач нет.';
    body.appendChild(empty);
    return;
  }

  for (const [index, task] of filterResults.entries()) {
    const row = document.createElement('div');
    row.className = 'filter-result';
    row.dataset.index = String(index);
    row.tabIndex = 0;

    const date = document.createElement('span');
    date.className = 'filter-result__date';
    date.textContent = formatDateRu(task.date);

    const main = document.createElement('div');
    main.className = 'filter-result__main';

    const client = document.createElement('div');
    client.className = 'filter-result__client';
    client.textContent = task.clientName + (task.clientArchived ? ' · архив' : '');
    main.appendChild(client);

    const title = document.createElement('div');
    title.className = 'filter-result__title';
    title.textContent = task.title;
    main.appendChild(title);

    const details = [];
    if (task.taxLines && task.taxLines.length > 0) details.push(task.taxLines.join(' · '));
    if (task.comment) details.push(`Комментарий: ${task.comment}`);
    if (details.length > 0) {
      const extra = document.createElement('div');
      extra.className = 'filter-result__details';
      extra.textContent = details.join(' · ');
      main.appendChild(extra);
    }

    const status = document.createElement('span');
    status.className = `filter-result__status filter-result__status--${task.status}`;
    status.textContent = statusLabel(task.status);

    row.append(date, main, status);
    body.appendChild(row);
  }
}

async function runFilter() {
  const requestId = ++filterRequestId;
  const params = new URLSearchParams();

  if (filterMode === 'tasks') {
    const q = $('filter-task-query').value.trim();
    if (q) params.set('q', q);
  }

  if (filterMode === 'client') {
    const clientId = $('filter-client').value;
    if (clientId) params.set('clientId', clientId);
  }

  if (filterMode === 'date') {
    const fromText = $('filter-from').value.trim();
    const toText = $('filter-to').value.trim();

    const from = fromText ? parseRuDate(fromText) : null;
    const to = toText ? parseRuDate(toText) : null;

    if (fromText && !from) {
      alert('Дата в поле «С» должна быть в формате ДД-ММ-ГГГГ');
      return;
    }
    if (toText && !to) {
      alert('Дата в поле «По» должна быть в формате ДД-ММ-ГГГГ');
      return;
    }

    // Одна дата — это и начало, и конец периода.
    const start = from || to;
    const end = to || from;
    if (start && end) {
      if (start > end) {
        alert('Начало периода позже его конца');
        return;
      }
      params.set('from', start);
      params.set('to', end);
    }
  }

  if (filterMode === 'status') {
    const status = $('filter-status').value;
    if (status) params.set('status', status);
  }

  const result = await api(`/api/search/tasks?${params.toString()}`);

  if (requestId !== filterRequestId) return;

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error)
      || (result.data && result.data.errors && result.data.errors.join('\n'))
      || 'Не удалось выполнить поиск');
    return;
  }

  renderFilterResults(result.data);
}

// Двойной клик по результату: неделя задачи и прокрутка к клиенту (FR-41).
async function goToTask(task) {
  const mode = task.clientArchived ? 'archive' : 'active';
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  $('client-search').value = '';
  weekFrom = startOfWeek(task.date);
  closeFilters();
  scheduleSettingsSave();

  await loadWeek();

  const row = document.querySelector(`#week-grid-body tr[data-id="${task.clientId}"]`);
  if (!row) return;

  row.scrollIntoView({ block: 'center' });
  row.classList.add('is-highlighted');
  setTimeout(() => row.classList.remove('is-highlighted'), 2500);
}

// --- Чек-листы (FR-42) ---

let checklistsCache = [];
let checklistDraft = null;

function renderChecklistsList() {
  const list = $('checklists-list');
  list.textContent = '';

  if (checklistsCache.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'checklists-empty';
    empty.textContent = 'Чек-листов пока нет.';
    list.appendChild(empty);
    return;
  }

  for (const checklist of checklistsCache) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'checklists-item';
    if (checklistDraft && checklistDraft.id === checklist.id) button.classList.add('is-active');

    const title = document.createElement('span');
    title.className = 'checklists-item__title';
    title.textContent = checklist.title;

    const count = document.createElement('span');
    count.className = 'checklists-item__count';
    count.textContent = `${checklist.items.length} п.`;

    button.append(title, count);
    button.addEventListener('click', () => selectChecklist(checklist.id));
    list.appendChild(button);
  }
}

function checklistItemRow(item, index) {
  const row = document.createElement('div');
  row.className = 'checklist-item';

  const number = document.createElement('span');
  number.className = 'checklist-item__number';
  number.textContent = String(index + 1);

  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'checklist-item__text';
  text.maxLength = 300;
  text.placeholder = 'Название задачи';
  text.value = item.text;
  text.addEventListener('input', () => {
    checklistDraft.items[index].text = text.value;
  });

  // Привязка пункта: дата, период (неделя / месяц / квартал) или ничего.
  const bind = document.createElement('select');
  bind.className = 'checklist-item__bind';
  for (const [value, label] of [
    ['date', 'дата'],
    ['period', 'период'],
    ['none', 'без даты'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    bind.appendChild(option);
  }
  bind.value = item.bind || 'none';
  bind.addEventListener('change', () => {
    checklistDraft.items[index].bind = bind.value;
    renderChecklistEditor();
  });

  const controls = document.createElement('span');
  controls.className = 'checklist-item__controls';

  if ((item.bind || 'none') === 'date') {
    const dateField = document.createElement('span');
    dateField.className = 'date-field';
    const date = document.createElement('input');
    date.type = 'text';
    date.className = 'checklist-item__date';
    date.placeholder = 'ДД-ММ-ГГГГ';
    date.maxLength = 10;
    date.value = item.dateText || '';
    date.addEventListener('input', () => {
      checklistDraft.items[index].dateText = date.value;
    });
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'date-pick';
    pick.title = 'Выбрать дату';
    pick.textContent = '📅';
    dateField.append(date, pick);
    controls.appendChild(dateField);
  }

  if ((item.bind || 'none') === 'period') {
    const period = document.createElement('select');
    period.className = 'checklist-item__period';
    for (const [value, label] of [
      ['week', 'неделя'],
      ['month', 'месяц'],
      ['quarter', 'квартал'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      period.appendChild(option);
    }
    period.value = item.period || 'month';
    period.addEventListener('change', () => {
      checklistDraft.items[index].period = period.value;
    });

    const position = document.createElement('select');
    position.className = 'checklist-item__pos';
    for (const [value, label] of [
      ['start', 'начало'],
      ['middle', 'середина'],
      ['end', 'конец'],
      ['dayOfMonth', 'число месяца'],
      ['weekday', 'день недели'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      position.appendChild(option);
    }
    position.value = item.periodPos || 'end';
    position.addEventListener('change', () => {
      const entry = checklistDraft.items[index];
      entry.periodPos = position.value;

      // «Число месяца» и «день недели» задают свой шаг: месяц и неделя.
      // Значение сбрасывается на подходящее, если прежнее не подходит
      // к новому варианту (например, 15 при переходе к дню недели).
      if (position.value === 'dayOfMonth') {
        entry.period = 'month';
        if (!(entry.periodDay >= 1 && entry.periodDay <= 31)) entry.periodDay = 15;
      } else if (position.value === 'weekday') {
        entry.period = 'week';
        if (!(entry.periodDay >= 0 && entry.periodDay <= 6)) entry.periodDay = 0;
      }
      renderChecklistEditor();
    });

    controls.append(period, position);

    // Уточнение для вариантов «число месяца» и «день недели».
    if (item.periodPos === 'dayOfMonth') {
      period.disabled = true;
      period.title = 'Шаг задаётся вариантом «число месяца»';

      const day = document.createElement('input');
      day.type = 'number';
      day.className = 'checklist-item__day';
      day.min = '1';
      day.max = '31';
      day.title = 'Число месяца';
      day.value = String(item.periodDay || 15);
      day.addEventListener('input', () => {
        checklistDraft.items[index].periodDay = Number(day.value);
      });
      controls.appendChild(day);
    }

    if (item.periodPos === 'weekday') {
      period.disabled = true;
      period.title = 'Шаг задаётся вариантом «день недели»';

      const weekday = document.createElement('select');
      weekday.className = 'checklist-item__weekday';
      weekday.title = 'День недели';
      for (const [value, label] of [
        [0, 'понедельник'],
        [1, 'вторник'],
        [2, 'среда'],
        [3, 'четверг'],
        [4, 'пятница'],
        [5, 'суббота'],
        [6, 'воскресенье'],
      ]) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = label;
        weekday.appendChild(option);
      }
      weekday.value = String(item.periodDay === null || item.periodDay === undefined ? 0 : item.periodDay);
      // Если значение не подходит (старый черновик), выбираем понедельник.
      if (weekday.selectedIndex < 0) weekday.value = '0';
      weekday.addEventListener('change', () => {
        checklistDraft.items[index].periodDay = Number(weekday.value);
      });
      controls.appendChild(weekday);
    }
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'checklist-item__remove';
  remove.textContent = '✕';
  remove.title = 'Удалить пункт';
  remove.addEventListener('click', () => {
    checklistDraft.items.splice(index, 1);
    renderChecklistEditor();
  });

  row.append(number, text, bind, controls, remove);
  return row;
}

function renderChecklistEditor() {
  if (!checklistDraft) return;

  $('checklist-title').value = checklistDraft.title;
  $('checklist-delete').disabled = !checklistDraft.id;
  $('checklist-status').textContent = checklistDraft.id ? 'Сохранён' : 'Новый чек-лист';

  const items = $('checklist-items');
  items.textContent = '';

  if (checklistDraft.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'checklists-empty';
    empty.textContent = 'Пунктов пока нет. Нажмите «Добавить пункт».';
    items.appendChild(empty);
  }

  checklistDraft.items.forEach((item, index) => {
    items.appendChild(checklistItemRow(item, index));
  });

  renderChecklistsList();
}

function selectChecklist(id) {
  const source = checklistsCache.find((item) => item.id === id);
  if (!source) return;

  checklistDraft = {
    id: source.id,
    title: source.title,
    items: source.items.map((item) => ({
      text: item.text,
      bind: item.period ? 'period' : (item.date ? 'date' : 'none'),
      dateText: item.date ? formatDateRu(item.date) : '',
      period: item.period || 'month',
      periodPos: item.periodPos || 'end',
      periodDay: item.periodDay === null || item.periodDay === undefined ? null : item.periodDay,
    })),
  };
  renderChecklistEditor();
}

function newChecklist() {
  checklistDraft = {
    id: null,
    title: '',
    items: [{ text: '', bind: 'none', dateText: '', period: 'month', periodPos: 'end', periodDay: null }],
  };
  renderChecklistEditor();
  $('checklist-title').focus();
}

async function loadChecklists() {
  const result = await api('/api/checklists');

  if (result.status === 401) {
    showLogin();
    return false;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось загрузить чек-листы');
    return false;
  }

  checklistsCache = result.data.checklists || [];
  renderChecklistsList();
  return true;
}

async function openChecklists() {
  const clients = await loadAllClients();
  if (!clients) {
    alert('Не удалось загрузить клиентов');
    return;
  }

  fillClientSelect($('checklist-client'), clients, null);
  if (!(await loadChecklists())) return;

  const start = weekFrom || startOfWeek(isoToday());
  $('checklist-from').value = formatDateRu(start);
  $('checklist-to').value = formatDateRu(addDays(start, 6));

  if (checklistsCache.length > 0) selectChecklist(checklistsCache[0].id);
  else newChecklist();

  $('checklists-modal').hidden = false;
}

function closeChecklists() {
  $('checklists-modal').hidden = true;
}

function collectChecklistPayload() {
  const items = [];

  for (const [index, item] of checklistDraft.items.entries()) {
    const text = item.text.trim();
    const bind = item.bind || 'none';

    if (bind === 'date') {
      const dateText = item.dateText.trim();
      if (!dateText) {
        alert(`Пункт ${index + 1}: укажите дату или выберите «без даты»`);
        return null;
      }
      const date = parseRuDate(dateText);
      if (!date) {
        alert(`Пункт ${index + 1}: дата должна быть в формате ДД-ММ-ГГГГ`);
        return null;
      }
      items.push({ text, date, period: null, periodPos: null, periodDay: null });
      continue;
    }

    if (bind === 'period') {
      items.push({
        text,
        date: null,
        period: item.period,
        periodPos: item.periodPos,
        periodDay: item.periodDay === undefined ? null : item.periodDay,
      });
      continue;
    }

    items.push({ text, date: null, period: null, periodPos: null, periodDay: null });
  }

  return { title: checklistDraft.title.trim(), items };
}

async function saveChecklist() {
  if (!checklistDraft) return;

  const payload = collectChecklistPayload();
  if (!payload) return;

  if (!payload.title) {
    alert('Укажите название чек-листа');
    $('checklist-title').focus();
    return;
  }
  if (payload.items.length === 0) {
    alert('Добавьте хотя бы один пункт');
    return;
  }

  const result = checklistDraft.id
    ? await api(`/api/checklists/${checklistDraft.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    : await api('/api/checklists', { method: 'POST', body: JSON.stringify(payload) });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.errors && result.data.errors.join('\n'))
      || (result.data && result.data.error)
      || 'Не удалось сохранить чек-лист');
    return;
  }

  const saved = result.data.checklist;
  if (!(await loadChecklists())) return;
  selectChecklist(saved.id);
}

async function deleteChecklist() {
  if (!checklistDraft || !checklistDraft.id) return;

  const source = checklistsCache.find((item) => item.id === checklistDraft.id);
  const title = source ? source.title : checklistDraft.title;
  if (!confirm(`Удалить чек-лист «${title}»?`)) return;

  const result = await api(`/api/checklists/${checklistDraft.id}`, { method: 'DELETE' });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось удалить чек-лист');
    return;
  }

  if (!(await loadChecklists())) return;
  if (checklistsCache.length > 0) selectChecklist(checklistsCache[0].id);
  else newChecklist();
}

async function applyChecklist() {
  if (!checklistDraft || !checklistDraft.id) {
    alert('Сначала сохраните чек-лист');
    return;
  }

  const clientId = $('checklist-client').value;
  if (!clientId) {
    alert('Выберите клиента');
    return;
  }

  const from = parseRuDate($('checklist-from').value);
  const to = parseRuDate($('checklist-to').value);

  if (!from || !to) {
    alert('Начало и конец периода должны быть в формате ДД-ММ-ГГГГ');
    return;
  }
  if (from > to) {
    alert('Начало периода позже его конца');
    return;
  }

  const result = await api(`/api/checklists/${checklistDraft.id}/apply`, {
    method: 'POST',
    body: JSON.stringify({ clientId, from, to }),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error) || 'Не удалось применить чек-лист');
    return;
  }

  const summary = result.data;
  closeChecklists();

  // Показываем неделю, в которой появились задачи.
  const mode = summary.client && summary.client.archived ? 'archive' : 'active';
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $('client-search').value = '';
  weekFrom = startOfWeek(from);
  scheduleSettingsSave();
  await loadWeek();

  alert(
    `Чек-лист применён к клиенту «${summary.client ? summary.client.name : ''}».\n` +
    `Создано задач: ${summary.created}\n` +
    `Пропущено пунктов вне периода: ${summary.skipped}`,
  );
}

// --- Печать реестра платежей (дополнение к FR-43) ---

// Реестр печатается отдельной кнопкой в своём экране: печатается ровно то,
// что сейчас показано — с учётом фильтров. Диалог «Печать» при этом остаётся
// с двумя режимами, как требует AC-43.
function printRegistryHtml() {
  const payments = (registryData && registryData.payments) || [];

  if (payments.length === 0) {
    return '<p class="print-empty">В реестре нет записей по текущим фильтрам.</p>';
  }

  // Условия печати — те же фильтры, что применены в реестре.
  const parts = [];
  const fromText = $('registry-from').value.trim();
  const toText = $('registry-to').value.trim();
  if (fromText || toText) {
    parts.push(`Период: ${fromText || '…'} — ${toText || '…'}`);
  }
  const clientSelect = $('registry-client');
  if (clientSelect.value) {
    parts.push(`Организация: ${clientSelect.options[clientSelect.selectedIndex].textContent}`);
  }
  const taxSelect = $('registry-tax');
  if (taxSelect.value) parts.push(`Налог: ${taxSelect.value}`);
  const filtersLine = parts.length > 0
    ? `<p class="print-meta">${parts.map(escapeHtml).join(' · ')}</p>`
    : '<p class="print-meta">Все записи</p>';

  // Строки сгруппированы по дате, как в самом реестре.
  const byDate = new Map();
  for (const payment of payments) {
    if (!byDate.has(payment.paymentDate)) byDate.set(payment.paymentDate, []);
    byDate.get(payment.paymentDate).push(payment);
  }

  const dateTotals = new Map(
    ((registryData.totals && registryData.totals.byDate) || []).map((entry) => [entry.date, entry.total]),
  );

  const rows = [];
  for (const [date, group] of byDate) {
    for (const payment of group) {
      const lines = payment.lines
        .map((line) => `<div class="print-comment">${escapeHtml(paymentLineText(line))}</div>`)
        .join('');
      const comment = payment.comment
        ? `<div class="print-comment">Комментарий: ${escapeHtml(payment.comment)}</div>`
        : '';

      rows.push(
        '<tr>' +
        `<td class="print-date">${formatDateRu(date)}</td>` +
        `<td>${escapeHtml(payment.clientName)}${payment.manual ? '<div class="print-comment">запись вручную</div>' : ''}</td>` +
        `<td>${lines}${comment}</td>` +
        `<td class="print-sum">${money(payment.total)} ₽</td>` +
        '</tr>',
      );
    }

    // Итог за дату — после её записей.
    rows.push(
      '<tr class="print-total">' +
      `<td colspan="3">Итого за ${formatDateRu(date)}</td>` +
      `<td class="print-sum">${money(dateTotals.get(date) || 0)} ₽</td>` +
      '</tr>',
    );
  }

  // Итоги по клиентам и общий — как внизу реестра.
  const byClient = ((registryData.totals && registryData.totals.byClient) || [])
    .map((entry) =>
      '<tr>' +
      `<td colspan="3">${escapeHtml(entry.name)}</td>` +
      `<td class="print-sum">${money(entry.total)} ₽</td>` +
      '</tr>',
    )
    .join('');

  const grand = ((registryData.totals && registryData.totals.grand) || 0);

  return (
    '<h1>Реестр платежей</h1>' +
    filtersLine +
    `<p class="print-meta">Записей: ${payments.length} · Печать от ${formatDateRu(isoToday())}</p>` +
    '<table class="print-table print-table--registry"><thead><tr>' +
    '<th>Дата</th><th>Организация</th><th>Платёж</th><th>Сумма</th>' +
    `</tr></thead><tbody>${rows.join('')}</tbody>` +
    '<tfoot>' +
    `<tr><th colspan="3">Итоги по клиентам</th><th></th></tr>${byClient}` +
    '<tr class="print-grand"><td colspan="3">Всего</td>' +
    `<td class="print-sum">${money(grand)} ₽</td></tr>` +
    '</tfoot></table>'
  );
}

function printRegistry() {
  const html = printRegistryHtml();
  $('print-area').innerHTML = html || '';
  window.print();
}

// --- Печать: рабочая таблица или набор задач (FR-43) ---

let printMode = 'week';
let printTasks = [];
let printRequestId = 0;

function printStatusClass(status) {
  return `print-task--${status}`;
}

function printWeekHtml() {
  if (!weekData) return '';

  const days = weekDays();
  const head = days
    .map((day, index) => `<th>${WEEKDAY_NAMES[index]}<br>${formatDateRu(day)}</th>`)
    .join('');

  const rows = weekData.clients.map((client) => {
    const cells = days
      .map((day) => {
        const items = (client.tasks || [])
          .filter((task) => task.date === day)
          .map((task) => `<div class="print-task ${printStatusClass(task.status)}">${escapeHtml(task.title)}</div>`)
          .join('');
        return `<td>${items}</td>`;
      })
      .join('');

    return `<tr><td class="print-client"><strong>${escapeHtml(client.name)}</strong><br><span>${escapeHtml(metaLine(client))}</span></td>${cells}</tr>`;
  }).join('');

  if (!rows) {
    return '<p class="print-empty">В текущей неделе клиентов нет.</p>';
  }

  return (
    '<h1>Рабочая таблица</h1>' +
    `<p class="print-meta">Неделя: ${formatDateRu(weekFrom)} — ${formatDateRu(addDays(weekFrom, 6))}</p>` +
    `<table class="print-table print-table--week"><thead><tr><th>Клиент</th>${head}</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function printTasksHtml() {
  if (printTasks.length === 0) {
    return '<p class="print-empty">Набор задач пуст. Задайте условия поиска выше и нажмите «Найти».</p>';
  }

  const rows = [...printTasks]
    .sort((a, b) => a.date.localeCompare(b.date) || a.clientName.localeCompare(b.clientName, 'ru'))
    .map((task) => {
      const comment = task.comment ? `<div class="print-comment">${escapeHtml(task.comment)}</div>` : '';
      return (
        '<tr>' +
        `<td class="print-date">${formatDateRu(task.date)}</td>` +
        `<td>${escapeHtml(task.clientName)}</td>` +
        `<td>${escapeHtml(task.title)}${comment}</td>` +
        `<td>${escapeHtml(statusLabel(task.status))}</td>` +
        '</tr>'
      );
    })
    .join('');

  return (
    '<h1>Набор задач</h1>' +
    `<p class="print-meta">Задач: ${printTasks.length}</p>` +
    '<table class="print-table"><thead><tr><th>Дата</th><th>Клиент</th><th>Задача</th><th>Статус</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderPrintPreview() {
  const html = printMode === 'tasks' ? printTasksHtml() : printWeekHtml();

  $('print-preview').innerHTML = html || '<p class="print-empty">Нет данных для печати.</p>';
  $('print-area').innerHTML = html || '';
}

// Поиск задач прямо в окне печати: набор собирается без окна «Фильтры».
async function runPrintSearch() {
  const requestId = ++printRequestId;
  const params = new URLSearchParams();

  const q = $('print-q').value.trim();
  if (q) params.set('q', q);

  const clientId = $('print-client').value;
  if (clientId) params.set('clientId', clientId);

  const fromText = $('print-from').value.trim();
  const toText = $('print-to').value.trim();
  const from = fromText ? parseRuDate(fromText) : null;
  const to = toText ? parseRuDate(toText) : null;

  if (fromText && !from) {
    alert('Дата в поле «С» должна быть в формате ДД-ММ-ГГГГ');
    return;
  }
  if (toText && !to) {
    alert('Дата в поле «По» должна быть в формате ДД-ММ-ГГГГ');
    return;
  }

  // Одна дата — это и начало, и конец периода.
  const start = from || to;
  const end = to || from;
  if (start && end) {
    if (start > end) {
      alert('Начало периода позже его конца');
      return;
    }
    params.set('from', start);
    params.set('to', end);
  }

  const status = $('print-status').value;
  if (status) params.set('status', status);

  const result = await api(`/api/search/tasks?${params.toString()}`);

  // Пока шёл поиск, пользователь мог нажать «Найти» ещё раз.
  if (requestId !== printRequestId) return;

  if (result.status === 401) {
    showLogin();
    return;
  }
  if (!result.ok) {
    alert((result.data && result.data.error)
      || (result.data && result.data.errors && result.data.errors.join('\n'))
      || 'Не удалось найти задачи');
    return;
  }

  printTasks = result.data.tasks || [];
  $('print-tasks-count').textContent = String(printTasks.length);
  renderPrintPreview();
}

function updatePrintMode(mode) {
  printMode = mode === 'tasks' ? 'tasks' : 'week';
  $('print-search').hidden = printMode !== 'tasks';

  const tasksRadio = document.querySelector('input[name="print-mode"][value="tasks"]');
  const weekRadio = document.querySelector('input[name="print-mode"][value="week"]');
  if (tasksRadio) tasksRadio.checked = printMode === 'tasks';
  if (weekRadio) weekRadio.checked = printMode === 'week';

  renderPrintPreview();
}

async function openPrintModal(mode, tasks) {
  // Клиент для поиска подгружается сразу, чтобы список был готов к вводу.
  const clients = await loadAllClients();
  if (clients) fillClientSelect($('print-client'), clients, 'все клиенты');

  const selected = Array.isArray(tasks) ? tasks : [];
  printTasks = mode === 'tasks' ? selected : [];
  $('print-tasks-count').textContent = String(printTasks.length);

  $('print-modal').hidden = false;
  updatePrintMode(mode === 'tasks' ? 'tasks' : 'week');

  if (printMode === 'tasks' && printTasks.length === 0) {
    // Набор ещё не собран: сразу показываем, что есть по пустым условиям.
    runPrintSearch();
  }
}

function closePrintModal() {
  $('print-modal').hidden = true;
}

// --- Экспорт и импорт копии (FR-53…FR-55) ---

const IMPORT_SECTIONS = [
  ['clients', 'Клиенты'],
  ['tasks', 'Задачи'],
  ['payments', 'Платежи'],
  ['paymentLines', 'Строки расшифровки'],
  ['templates', 'Шаблоны'],
  ['checklists', 'Чек-листы'],
  ['checklistItems', 'Пункты чек-листов'],
];

let noticeTimer = null;
let importFile = null;
let importBusy = false;

function showNotice(message, isError = false) {
  const node = $('notice');
  node.textContent = message;
  node.classList.toggle('notice--error', isError);
  node.hidden = false;

  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    node.hidden = true;
  }, 6000);
}

async function exportData() {
  const button = $('btn-export');
  button.disabled = true;

  try {
    const response = await fetch('/api/export', { credentials: 'same-origin' });

    if (response.status === 401) {
      showLogin();
      return;
    }

    if (!response.ok) {
      let message = 'Не удалось выгрузить данные';
      try {
        const data = await response.json();
        if (data && data.error) message = data.error;
      } catch (error) {
        // Ответ без JSON — оставляем общее сообщение.
      }
      showNotice(message, true);
      return;
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const name = match ? match[1] : 'asbuhg-backup.json';

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showNotice(`Копия данных выгружена в файл ${name}`);
  } catch (error) {
    showNotice(`Не удалось выгрузить данные: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function openImportModal() {
  importFile = null;

  $('import-file').value = '';
  $('import-report').hidden = true;
  $('import-counts-body').textContent = '';
  $('import-errors').hidden = true;
  $('import-errors').textContent = '';
  $('import-status').textContent = '';
  $('import-status').className = 'import-status';
  $('import-run').disabled = true;
  $('import-run').textContent = 'Импортировать';
  $('import-modal').hidden = false;
}

function closeImportModal() {
  $('import-modal').hidden = true;
}

function renderImportCounts(file, current) {
  const body = $('import-counts-body');
  body.textContent = '';

  for (const [key, label] of IMPORT_SECTIONS) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = label;
    const inFile = document.createElement('td');
    inFile.textContent = String((file && file[key]) || 0);
    const inBase = document.createElement('td');
    inBase.textContent = String((current && current[key]) || 0);
    row.append(name, inFile, inBase);
    body.appendChild(row);
  }
}

function showImportErrors(errors) {
  const list = $('import-errors');
  list.textContent = '';

  for (const message of errors) {
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  }

  list.hidden = errors.length === 0;
}

async function previewImport(file) {
  const status = $('import-status');
  status.textContent = 'Проверяем файл…';
  status.className = 'import-status';
  $('import-run').disabled = true;

  const result = await api('/api/import/preview', {
    method: 'POST',
    body: JSON.stringify(file),
  });

  if (result.status === 401) {
    showLogin();
    return;
  }

  $('import-report').hidden = false;

  if (!result.ok) {
    const data = result.data || {};
    const errors = Array.isArray(data.errors) && data.errors.length > 0
      ? data.errors
      : [data.error || 'Не удалось проверить файл'];
    status.textContent = 'Файл не принят.'
    status.className = 'import-status is-invalid';
    showImportErrors(errors);
    return;
  }

  const data = result.data;
  importFile = file;
  renderImportCounts(data.file, data.current);
  showImportErrors(data.errors || []);

  if (data.valid) {
    status.textContent = 'Файл проверен. Нажмите «Импортировать», чтобы заменить данные.';
    status.className = 'import-status is-valid';
    $('import-run').disabled = false;
  } else {
    status.textContent = 'Файл не принят: исправьте замечания и выберите файл снова.';
    status.className = 'import-status is-invalid';
  }
}

async function handleImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];

  importFile = null;
  $('import-report').hidden = true;
  $('import-run').disabled = true;
  $('import-errors').hidden = true;
  $('import-errors').textContent = '';
  $('import-status').textContent = '';
  $('import-status').className = 'import-status';

  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    $('import-report').hidden = false;
    $('import-status').textContent = 'Файл не является корректным JSON.';
    $('import-status').className = 'import-status is-invalid';
    showImportErrors(['Не удалось прочитать JSON из выбранного файла']);
    return;
  }

  await previewImport(parsed);
}

async function applyImport() {
  if (!importFile || importBusy) return;

  const confirmed = window.confirm(
    'Заменить всех клиентов, задачи, платежи, шаблоны, чек-листы и настройки вида данными из файла?\n' +
    'Текущие данные будут удалены.',
  );
  if (!confirmed) return;

  const button = $('import-run');
  importBusy = true;
  button.disabled = true;
  button.textContent = 'Импортируем…';

  try {
    const result = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify(importFile),
    });

    if (result.status === 401) {
      showLogin();
      return;
    }

    if (!result.ok) {
      const data = result.data || {};
      const errors = Array.isArray(data.errors) && data.errors.length > 0
        ? data.errors
        : [data.error || 'Не удалось импортировать данные'];
      $('import-status').textContent = 'Данные не изменены.';
      $('import-status').className = 'import-status is-invalid';
      showImportErrors(errors);
      return;
    }

    const counts = (result.data && result.data.imported) || {};
    applyUiSettings(result.data && result.data.ui);
    closeImportModal();
    goHome();
    await loadWeek();
    showNotice(
      `Импорт завершён: клиентов ${counts.clients || 0}, задач ${counts.tasks || 0}, ` +
      `платежей ${counts.payments || 0}.`,
    );
  } catch (error) {
    $('import-status').textContent = 'Данные не изменены.';
    $('import-status').className = 'import-status is-invalid';
    showImportErrors([`Не удалось импортировать данные: ${error.message}`]);
  } finally {
    importBusy = false;
    button.textContent = 'Импортировать';
    button.disabled = !importFile;
  }
}

async function boot() {
  // Сначала состояние базы: при повреждении показываем восстановление (AC-51).
  const state = await api('/api/recovery').catch(() => ({ ok: false }));
  if (state.ok && state.data && state.data.needed) {
    showRecovery(state.data.error);
    return;
  }

  const me = await api('/api/auth/me').catch(() => ({ ok: false }));
  if (me.ok) {
    showApp(me.data);
    await loadUiSettings();
    if (!weekFrom) weekFrom = startOfWeek(isoToday());
    await loadWeek();
  } else {
    showLogin();
  }
}

$('login-form').addEventListener('submit', submitLogin);
$('btn-logout').addEventListener('click', logout);

// Восстановление после повреждённой базы (FR-51, AC-51).
$('recovery-restore').addEventListener('click', restoreFromBackup);
$('recovery-start').addEventListener('click', startFromScratch);

$('btn-deadlines').addEventListener('click', openDeadlines);
$('btn-deadlines-close').addEventListener('click', closeDeadlines);
$('btn-home').addEventListener('click', goHome);
$('deadlines-tab-rules').addEventListener('click', () => setDeadlinesTab('rules'));
$('deadlines-tab-calendar').addEventListener('click', () => setDeadlinesTab('calendar'));
$('calendar-year').addEventListener('change', renderCalendar);

// Обновление календаря нерабочих дней (FR-71…FR-79).
$('btn-calendar-update').addEventListener('click', () => {
  openCalendarModal('sources');
  runSourcesUpdate();
});
$('btn-calendar-template').addEventListener('click', downloadCalendarTemplate);
$('btn-calendar-upload').addEventListener('click', () => openCalendarModal('file'));
$('calendar-file').addEventListener('change', handleCalendarFile);
$('calendar-apply').addEventListener('click', applyCalendarChange);
$('calendar-cancel').addEventListener('click', closeCalendarModal);

// Источники календаря: адреса вводятся вручную (FR-71).
$('calendar-source-add').addEventListener('click', addCalendarSource);
$('calendar-source-save').addEventListener('click', saveCalendarSources);

// Сверка сроков отчётности с календарём источника (FR-74).
$('btn-reporting-check').addEventListener('click', runReportingCheck);
$('reporting-close').addEventListener('click', () => {
  $('reporting-modal').hidden = true;
});

// Поиск клиента на неделе (FR-06).
$('client-search').addEventListener('input', () => {
  loadWeek();
  if (!$('clients-view').hidden) renderDirectory();
});

// Фильтры (FR-37…FR-41).
$('btn-filters').addEventListener('click', openFilters);
$('filters-close').addEventListener('click', closeFilters);
$('filter-apply').addEventListener('click', runFilter);
$('filter-reset').addEventListener('click', resetFilters);
$('filter-print').addEventListener('click', () => {
  if (filterResults.length === 0) {
    alert('Сначала выполните поиск: набор задач пуст');
    return;
  }
  closeFilters();
  openPrintModal('tasks', filterResults);
});
for (const tab of document.querySelectorAll('.filter-tab')) {
  tab.addEventListener('click', () => setFilterMode(tab.dataset.filterMode));
}
$('filter-task-query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runFilter();
});
$('filter-results').addEventListener('dblclick', (event) => {
  const row = event.target.closest('.filter-result');
  if (!row) return;
  const task = filterResults[Number(row.dataset.index)];
  if (task) goToTask(task);
});

// Чек-листы (FR-42).
$('btn-checklists').addEventListener('click', openChecklists);
$('checklists-close').addEventListener('click', closeChecklists);
$('checklist-new').addEventListener('click', newChecklist);
$('checklist-add-item').addEventListener('click', () => {
  if (!checklistDraft) return;
  checklistDraft.items.push({ text: '', dateText: '' });
  renderChecklistEditor();
});
$('checklist-save').addEventListener('click', saveChecklist);
$('checklist-delete').addEventListener('click', deleteChecklist);
$('checklist-apply-btn').addEventListener('click', applyChecklist);
$('checklist-title').addEventListener('input', () => {
  if (checklistDraft) checklistDraft.title = $('checklist-title').value;
});

// Печать (FR-43).
$('btn-print').addEventListener('click', () => openPrintModal('week', []));
$('print-cancel').addEventListener('click', closePrintModal);
$('print-run').addEventListener('click', () => {
  renderPrintPreview();
  window.print();
});
for (const radio of document.querySelectorAll('input[name="print-mode"]')) {
  radio.addEventListener('change', () => {
    updatePrintMode(radio.value);
    // Переключились на набор, а он ещё не собран — собираем сразу.
    if (printMode === 'tasks' && printTasks.length === 0) runPrintSearch();
  });
}
$('print-search-btn').addEventListener('click', runPrintSearch);
$('print-q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runPrintSearch();
});

$('btn-export').addEventListener('click', exportData);
$('btn-import').addEventListener('click', openImportModal);
$('import-cancel').addEventListener('click', closeImportModal);
$('import-file').addEventListener('change', handleImportFile);
$('import-run').addEventListener('click', applyImport);

$('btn-payments').addEventListener('click', openRegistry);
$('btn-registry-close').addEventListener('click', closeRegistry);
$('registry-apply').addEventListener('click', loadRegistry);
$('registry-reset').addEventListener('click', () => {
  $('registry-from').value = '';
  $('registry-to').value = '';
  $('registry-tax').value = '';
  $('registry-client').value = '';
  loadRegistry();
});
$('registry-add-manual').addEventListener('click', openManualPayment);
$('registry-print').addEventListener('click', printRegistry);

$('payment-cancel').addEventListener('click', closePaymentForm);
$('payment-save').addEventListener('click', () => savePayment(false));
$('payment-add-line').addEventListener('click', addPaymentLine);
$('vat-split-btn').addEventListener('click', splitVat);
$('vat-amount').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') splitVat();
});
$('profit-split-btn').addEventListener('click', fixProfitAdvances);
$('profit-amount').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fixProfitAdvances();
});

$('btn-add-client').addEventListener('click', () => openClientForm(null));
$('btn-clients').addEventListener('click', openClients);
$('btn-clients-close').addEventListener('click', closeClients);
$('clients-add').addEventListener('click', () => openClientForm(null));
$('clients-print').addEventListener('click', printDirectory);
document.querySelector('.clients-table thead').addEventListener('click', (event) => {
  const th = event.target.closest('th[data-sort]');
  if (th) toggleDirectorySort(th.dataset.sort);
});
$('client-cancel').addEventListener('click', closeClientForm);
$('client-form').addEventListener('submit', submitClientForm);
$('client-extra').addEventListener('click', openFlags);
$('flags-close').addEventListener('click', closeFlags);
$('flags-add-btn').addEventListener('click', addFlag);

$('report-cancel').addEventListener('click', closeReport);
$('report-submit').addEventListener('click', submitReport);
$('report-select-all').addEventListener('click', selectAllReport);
$('report-clear-all').addEventListener('click', clearReportSelection);

$('catalog-cancel').addEventListener('click', closeCatalog);
$('catalog-submit').addEventListener('click', submitCatalog);
$('catalog-select-all').addEventListener('click', () => {
  for (const template of catalogTemplates) catalogSelected.add(template.id);
  renderCatalog();
});
$('catalog-clear-all').addEventListener('click', () => {
  catalogSelected = new Set();
  renderCatalog();
});
$('catalog-add-btn').addEventListener('click', addCatalogTemplate);
$('catalog-new-title').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addCatalogTemplate();
});
$('manual-add-btn').addEventListener('click', addManualTask);
$('manual-title').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addManualTask();
});

$('comment-cancel').addEventListener('click', closeComment);
$('comment-save').addEventListener('click', () => saveComment($('comment-text').value));
$('comment-clear').addEventListener('click', () => saveComment(''));

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    loadWeek();
    if (!$('clients-view').hidden) loadDirectory();
    scheduleSettingsSave();
  });
}

$('week-prev').addEventListener('click', () => {
  weekFrom = addDays(weekFrom, -7);
  scheduleSettingsSave();
  loadWeek();
});

$('week-next').addEventListener('click', () => {
  weekFrom = addDays(weekFrom, 7);
  scheduleSettingsSave();
  loadWeek();
});

// Клик по сетке: действия клиента, добавление задачи, статус, комментарий (FR-27…FR-35).
$('week-grid-body').addEventListener('click', (event) => {
  const comment = event.target.closest('button[data-action="comment"]');
  if (comment) {
    event.stopPropagation();
    const chip = comment.closest('.task-chip');
    if (chip) openComment(chip.dataset.taskId);
    return;
  }

  const add = event.target.closest('button[data-action="add-task"]');
  if (add) {
    const cell = add.closest('.week-cell');
    if (cell) openCatalog(cell.dataset.clientId, cell.dataset.date);
    return;
  }

  const chip = event.target.closest('.task-chip');
  if (chip) {
    showStatusMenu(chip.dataset.taskId, chip);
    return;
  }

  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const row = button.closest('tr');
  const id = row && row.dataset.id;
  const client = clientsList.find((item) => item.id === id);
  if (!client) return;

  if (button.dataset.action === 'edit') openClientForm(client);
  if (button.dataset.action === 'report') openReport(client);
  if (button.dataset.action === 'archive') setClientProperty(id, { archived: !client.archived });
  if (button.dataset.action === 'pin') setClientProperty(id, { pinned: !client.pinned });
});

// Справочник клиентов: те же действия, что в строке недели.
$('clients-body').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const row = button.closest('tr');
  const id = row && row.dataset.id;
  const client = directoryClients.find((item) => item.id === id);
  if (!client) return;

  if (button.dataset.action === 'edit') openClientForm(client);
  if (button.dataset.action === 'report') openReport(client);
  if (button.dataset.action === 'week') showClientOnWeek(client);
  if (button.dataset.action === 'archive') setClientProperty(id, { archived: !client.archived });
  if (button.dataset.action === 'pin') setClientProperty(id, { pinned: !client.pinned });
});

// Правый клик по задаче: «Удалить задачу» (FR-34).
$('week-grid-body').addEventListener('contextmenu', (event) => {
  const chip = event.target.closest('.task-chip');
  if (!chip) return;

  event.preventDefault();
  showTaskMenu(chip.dataset.taskId, event.clientX, event.clientY);
});

document.addEventListener('click', (event) => {
  if (event.target.closest('#status-menu') || event.target.closest('#task-menu')) return;
  if (event.target.closest('.task-chip')) return;
  hideTaskMenus();
});

// Выбор даты из календаря: кнопки «📅» и само окно календаря.
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('.date-pick');
  if (trigger) {
    event.stopPropagation();
    const field = trigger.closest('.date-field');
    const input = field && field.querySelector('input');
    if (input) openDatePicker(trigger, input);
    return;
  }

  if (event.target.closest('#date-picker')) {
    const nav = event.target.closest('.date-picker__nav');
    if (nav) {
      pickerMonth += Number(nav.dataset.step);
      if (pickerMonth < 1) {
        pickerMonth = 12;
        pickerYear -= 1;
      }
      if (pickerMonth > 12) {
        pickerMonth = 1;
        pickerYear += 1;
      }
      renderDatePicker();
      return;
    }

    const day = event.target.closest('.date-picker__day');
    if (day && pickerInput) {
      pickerInput.value = formatDateRu(day.dataset.date);
      pickerInput.dispatchEvent(new Event('input', { bubbles: true }));
      closeDatePicker();
    }
    return;
  }

  closeDatePicker();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;

  hideTaskMenus();
  closeDatePicker();
  if (!$('catalog-modal').hidden) closeCatalog();
  if (!$('comment-modal').hidden) closeComment();
  if (!$('payment-modal').hidden) closePaymentForm();
  if (!$('filters-modal').hidden) closeFilters();
  if (!$('checklists-modal').hidden) closeChecklists();
  if (!$('print-modal').hidden) closePrintModal();
});

window.addEventListener('scroll', () => {
  hideTaskMenus();
  closeDatePicker();
}, true);
window.addEventListener('resize', () => {
  hideTaskMenus();
  closeDatePicker();
});

boot();
